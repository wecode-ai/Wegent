// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Recover managed installations from their identity and verified current packages.
//! Historical absolute paths are evidence, never filesystem mutation targets.

use super::*;
use crate::services::workbench::{verify_published_package, PackageKind};

#[path = "runtime_recovery_journal.rs"]
mod journal;
use journal::RecoveryJournal;
#[path = "runtime_recovery_ownership.rs"]
mod ownership;
#[path = "runtime_recovery_plan.rs"]
mod plan;
use ownership::*;

#[derive(Debug, Default)]
pub struct PluginRuntimeRecoveryReport {
    pub restored: Vec<String>,
    pub failed: BTreeMap<String, String>,
}

impl GlobalCapabilityStore {
    pub fn reconcile_managed_plugin_runtimes(
        &self,
    ) -> Result<PluginRuntimeRecoveryReport, CapabilitySyncError> {
        let _publication = self.lock_shared_manifest()?;
        let mut manifest = self.manifest.load()?;
        let original = manifest.clone();
        let report = self.recover_managed_plugin_paths(&mut manifest);
        if manifest != original {
            self.manifest.save_with_revision_bump(manifest)?;
        }
        Ok(report)
    }

    pub(super) fn recover_managed_plugin_paths(
        &self,
        manifest: &mut Value,
    ) -> PluginRuntimeRecoveryReport {
        let mut report = PluginRuntimeRecoveryReport::default();
        let entries = object_map(manifest.get("plugins")).unwrap_or_default();
        let old_roots = historical_runtime_roots(&entries);
        for (key, entry) in entries {
            if entry.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            match self.recover_plugin(&key, &entry, manifest) {
                Ok(true) => report.restored.push(key.clone()),
                Ok(false) => (),
                Err(error) => {
                    let message = error.to_string();
                    manifest["plugins"][&key]["runtime_recovery_error"] = json!(message);
                    report.failed.insert(key, message);
                }
            }
        }
        self.rebase_retained_runtime_owners(manifest, &old_roots, &mut report);
        report
    }

    fn rebase_retained_runtime_owners(
        &self,
        manifest: &mut Value,
        old_roots: &BTreeMap<PathBuf, String>,
        report: &mut PluginRuntimeRecoveryReport,
    ) {
        let owners = object_map(manifest.get("plugin_runtime_owners")).unwrap_or_default();
        for (old, owner) in owners {
            let Some(key) = owner.as_str() else { continue };
            let path = Path::new(&old);
            let Some(version) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(runtime) = path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
            else {
                continue;
            };
            let plugin_root = path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::parent);
            let known = plugin_root
                .and_then(|root| old_roots.get(root))
                .map(String::as_str);
            let field = if let Some(field) = known {
                field
            } else {
                match runtime {
                    "claude" | ".claude" => "claude_link",
                    "codex" | ".codex" => "codex_link",
                    _ => continue,
                }
            };
            let (name, marketplace) = split_plugin_key(key);
            let spec = PluginSyncSpec::from_manifest_entry(
                key,
                &json!({"name":name,"marketplace":marketplace,"version":version}),
            );
            if checked_spec(
                key,
                &json!({"name":spec.name,"marketplace":spec.marketplace,"version":spec.version}),
            )
            .is_err()
                || !historical_cache_path(path, &spec, field)
            {
                continue;
            }
            if self.codex_only_plugins && field == "claude_link" {
                ensure_object_field(manifest, "plugin_runtime_owners").remove(&old);
                continue;
            }
            let target = if field == "codex_link" {
                self.plugin_codex_link(&spec)
            } else {
                self.plugins_dir
                    .join("cache")
                    .join(&spec.marketplace)
                    .join(&spec.name)
                    .join(version)
            };
            let next = target.to_string_lossy().into_owned();
            if next == old {
                continue;
            }
            if manifest
                .get("plugin_runtime_owners")
                .and_then(|owners| owners.get(&next))
                .and_then(Value::as_str)
                .is_some_and(|other| other != key)
            {
                report.failed.insert(
                    key.to_owned(),
                    "Conflicting retained runtime ownership; preserving both records".into(),
                );
                continue;
            }
            let active = manifest.get("plugins").and_then(|plugins| plugins.get(key));
            if !active.is_some_and(|entry| entry_owns_path(entry, &target, field)) {
                // Reinstall must prove a relocated retained directory against its
                // freshly verified package before it can claim the path.
                ensure_object_field(manifest, "plugin_runtime_relocated_owners")
                    .insert(next.clone(), json!(key));
            }
            ensure_object_field(manifest, "plugin_runtime_owner_origins")
                .insert(next.clone(), json!({"key":key,"path":old}));
            ensure_object_field(manifest, "plugin_runtime_owners").remove(&old);
            ensure_object_field(manifest, "plugin_runtime_owners").insert(next, json!(key));
        }
    }

    fn recover_plugin(
        &self,
        key: &str,
        entry: &Value,
        manifest: &mut Value,
    ) -> Result<bool, CapabilitySyncError> {
        let spec = checked_spec(key, entry)?;
        for (path, _) in self.plugin_runtime_targets(&spec) {
            self.ensure_runtime_path(&path, true)?;
        }
        let journal = self.recovery_journal_path(key);
        self.recover_plugin_journal(&journal, &spec, manifest)?;
        // Legacy private packages cannot be authenticated using an archive checksum
        // against an expanded directory. A later online sync can supply the archive.
        if !self.shared_packages {
            return Ok(false);
        }
        let mut next = entry.clone();
        self.rebase_plugin_entry(&mut next, true)?;
        if self.plugin_paths_current(entry, &next, &spec)? {
            let cleared_error = manifest["plugins"][key]
                .as_object_mut()
                .is_some_and(|entry| entry.remove("runtime_recovery_error").is_some());
            return Ok(cleared_error);
        }
        let checksum = spec.checksum.as_deref().ok_or_else(|| {
            CapabilitySyncError::invalid_payload(
                "Managed plugin needs a verified package; retry its installation online",
            )
        })?;
        let package = self.verified_plugin_package(checksum)?;
        validate_package_identity(&package.path, &spec)?;
        next["store_path"] = json!(package.path);
        let normalized = tempfile::tempdir()?;
        let template = normalized.path().join("runtime");
        copy_dir_atomic(&package.path, &template)?;
        ensure_dual_plugin_manifests(&template)?;
        ensure_plugin_hook_permissions(&template)?;
        for (target, field) in self.plugin_runtime_targets(&spec) {
            self.ensure_runtime_path(&target, true)?;
            if !exists(&target) || entry_owns_path(entry, &target, field) {
                continue;
            }
            let historical = entry
                .get("runtime")
                .and_then(|runtime| runtime.get(field))
                .and_then(Value::as_str)
                .map(Path::new);
            if !historical.is_some_and(|path| historical_cache_path(path, &spec, field))
                || !same_runtime_contents(&target, &template)?
            {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin recovery destination is occupied by an unrelated item; preserving it",
                ));
            }
        }
        self.validate_marketplace_occupancy(&spec, entry, manifest)?;
        let before = manifest.clone();
        let mut recovery = RecoveryJournal::prepare(self, &journal, &spec, &template, manifest)?;
        for (target, field) in self.plugin_runtime_targets(&spec) {
            if let Some(old) = entry
                .get("runtime")
                .and_then(|runtime| runtime.get(field))
                .and_then(Value::as_str)
                .filter(|old| {
                    Path::new(old) != target && historical_cache_path(Path::new(old), &spec, field)
                })
            {
                ensure_object_field(manifest, "plugin_runtime_owner_origins").insert(
                    target.to_string_lossy().into_owned(),
                    json!({"key":key,"path":old}),
                );
            }
        }
        mark_previous_ownership_pending(self, manifest, key, entry, &next);
        next["runtime_recovery_id"] = json!(recovery.transaction_id);
        manifest["plugins"][key] = next;
        let result = self.install_plugin_runtime_metadata_at(
            &spec,
            &package.path,
            manifest,
            &recovery.timestamp,
            Some(&recovery),
        );
        match result {
            Ok(()) => {
                recovery.finish()?;
                Ok(true)
            }
            Err(error) => {
                *manifest = before;
                match recovery.rollback(self, &spec) {
                    Ok(()) => Err(error),
                    Err(rollback) => Err(CapabilitySyncError::invalid_payload(format!(
                        "{error}; recovery snapshots retained: {rollback}"
                    ))),
                }
            }
        }
    }

    fn verified_plugin_package(
        &self,
        hash: &str,
    ) -> Result<crate::services::workbench::PublishedPackage, CapabilitySyncError> {
        let root = self.shared_root()?;
        let path = self.current_shared_plugin_path(hash)?;
        let digest = path.file_name().unwrap().to_string_lossy().into_owned();
        for path in [
            path,
            root.join("shared/metadata")
                .join(format!("plugins-{digest}.json")),
            root.join("shared/locks")
                .join(format!("plugins-{digest}.lock")),
        ] {
            safe_managed_path(&root, &path, false)?;
        }
        verify_published_package(&root, PackageKind::Plugin, hash)
            .map_err(CapabilitySyncError::invalid_payload)
    }

    fn current_shared_plugin_path(&self, hash: &str) -> Result<PathBuf, CapabilitySyncError> {
        let digest = hash
            .strip_prefix("sha256:")
            .unwrap_or(hash)
            .to_ascii_lowercase();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CapabilitySyncError::invalid_payload(
                "Invalid plugin package SHA256",
            ));
        }
        Ok(self.shared_root()?.join("shared/plugins").join(digest))
    }

    fn plugin_paths_current(
        &self,
        old: &Value,
        next: &Value,
        spec: &PluginSyncSpec,
    ) -> Result<bool, CapabilitySyncError> {
        // An unchanged private installation does not need a shared publication.
        // Its next online installation can publish the archive through the normal flow.
        let store_current = old.get("store_path") == next.get("store_path")
            || self.current_recorded_store_path(old)?.is_some();
        Ok(old.get("runtime") == next.get("runtime")
            && store_current
            && old.get("previous") == next.get("previous")
            && self.plugin_runtime_targets(spec).iter().all(|(path, _)| {
                path.is_dir()
                    && !path.is_symlink()
                    && path.join(CODEX_PLUGIN_MANIFEST_PATH).is_file()
                    && path.join(CLAUDE_PLUGIN_MANIFEST_PATH).is_file()
            }))
    }

    fn rebase_plugin_entry(
        &self,
        entry: &mut Value,
        active: bool,
    ) -> Result<(), CapabilitySyncError> {
        let key = value_string(entry.get("key"))
            .or_else(|| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .zip(entry.get("marketplace").and_then(Value::as_str))
                    .map(|(name, market)| format!("{name}@{market}"))
            })
            .ok_or_else(|| {
                CapabilitySyncError::invalid_payload("Managed plugin identity is missing")
            })?;
        let spec = checked_spec(&key, entry)?;
        let runtime = ensure_object_field(entry, "runtime");
        if self.codex_only_plugins {
            runtime.remove("claude_link");
        } else {
            runtime.insert("claude_link".into(), json!(self.plugin_runtime_link(&spec)));
        }
        runtime.insert("codex_link".into(), json!(self.plugin_codex_link(&spec)));
        if let Some(hash) = spec.checksum.as_deref() {
            match self.current_shared_plugin_path(hash) {
                Ok(path) => entry["store_path"] = json!(path),
                Err(error) if active => return Err(error),
                // Invalid archived metadata does not prevent the active plugin
                // from recovering; no historical package path is accessed.
                Err(_) => (),
            }
        }
        if let Some(previous) = entry.get_mut("previous").filter(|value| value.is_object()) {
            // Previous records may predate the explicit key field.
            previous["key"] = json!(key);
            self.rebase_plugin_entry(previous, false)?;
        }
        if let Some(object) = entry.as_object_mut() {
            object.remove("runtime_recovery_error");
        }
        Ok(())
    }

    pub(super) fn plugin_runtime_targets(
        &self,
        spec: &PluginSyncSpec,
    ) -> Vec<(PathBuf, &'static str)> {
        let mut targets = vec![(self.plugin_codex_link(spec), "codex_link")];
        if !self.codex_only_plugins {
            targets.push((self.plugin_runtime_link(spec), "claude_link"));
        }
        targets
    }

    fn ensure_runtime_path(&self, path: &Path, leaf_link: bool) -> Result<(), CapabilitySyncError> {
        let root = if path.starts_with(&self.codex_plugins_dir) {
            &self.codex_plugins_dir
        } else {
            &self.plugins_dir
        };
        safe_managed_path(root.parent().unwrap_or(root), path, leaf_link)
    }

    fn runtime_state_paths(&self, spec: &PluginSyncSpec) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let codex_market = self.codex_marketplace_dir(&spec.marketplace);
        let mut files = vec![
            codex_market.join(".agents/plugins/marketplace.json"),
            self.codex_plugins_dir
                .parent()
                .unwrap_or(Path::new("."))
                .join("config.toml"),
        ];
        let mut directories = vec![
            self.plugin_codex_link(spec),
            codex_market
                .join("plugins")
                .join(self.marketplace_plugin_name(spec, false)),
        ];
        if !self.codex_only_plugins {
            let market = self.claude_marketplace_dir(&spec.marketplace);
            files.extend([
                self.plugins_dir.join("known_marketplaces.json"),
                self.plugins_dir.join("installed_plugins.json"),
                self.plugins_dir
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join("settings.json"),
                market.join(".claude-plugin/marketplace.json"),
                market.join(".agents/plugins/marketplace.json"),
            ]);
            directories.extend([
                self.plugin_runtime_link(spec),
                market
                    .join("plugins")
                    .join(self.marketplace_plugin_name(spec, true)),
            ]);
        }
        files.sort();
        files.dedup();
        directories.sort();
        directories.dedup();
        (files, directories)
    }

    pub(super) fn ensure_state_path(
        &self,
        path: &Path,
        leaf_link: bool,
    ) -> Result<(), CapabilitySyncError> {
        let root = if path.starts_with(self.personal_marketplace_dir()) {
            self.manifest.path.parent().unwrap_or(Path::new("."))
        } else if path.starts_with(
            self.codex_plugins_dir
                .parent()
                .unwrap_or(&self.codex_plugins_dir),
        ) {
            self.codex_plugins_dir
                .parent()
                .unwrap_or(&self.codex_plugins_dir)
        } else {
            self.plugins_dir.parent().unwrap_or(&self.plugins_dir)
        };
        safe_managed_path(root, path, leaf_link)
    }

    fn matches_old_managed_copy(
        &self,
        target: &Path,
        entry: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        if entry.get("managed").and_then(Value::as_bool) != Some(true) {
            return Ok(false);
        }
        if let Some(hash) = entry.get("checksum").and_then(Value::as_str) {
            let package = self.verified_plugin_package(hash)?;
            let stage = tempfile::tempdir()?;
            let template = stage.path().join("runtime");
            copy_dir_atomic(&package.path, &template)?;
            ensure_dual_plugin_manifests(&template)?;
            ensure_plugin_hook_permissions(&template)?;
            return same_runtime_contents(target, &template);
        }
        let key = value_string(entry.get("key")).unwrap_or_default();
        let spec = checked_spec(&key, entry)?;
        for (runtime, field) in self.plugin_runtime_targets(&spec) {
            if entry_owns_path(entry, &runtime, field) {
                self.ensure_runtime_path(&runtime, false)?;
                if same_runtime_contents(target, &runtime)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn validate_marketplace_occupancy(
        &self,
        spec: &PluginSyncSpec,
        entry: &Value,
        manifest: &Value,
    ) -> Result<(), CapabilitySyncError> {
        let (files, directories) = self.runtime_state_paths(spec);
        for path in files.iter().chain(directories.iter()) {
            self.ensure_state_path(path, directories.contains(path))?;
        }
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
            let runtime = if claude {
                self.plugin_runtime_link(spec)
            } else {
                self.plugin_codex_link(spec)
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
                    linked == runtime
                        || retained
                        || manifest
                            .get("plugin_runtime_owner_origins")
                            .and_then(|origins| origins.get(runtime.to_string_lossy().as_ref()))
                            .is_some_and(|origin| {
                                origin.get("key").and_then(Value::as_str) == Some(spec.key.as_str())
                                    && origin.get("path").and_then(Value::as_str).map(Path::new)
                                        == Some(linked.as_path())
                            })
                        || entry
                            .get("runtime")
                            .and_then(|value| {
                                value.get(if claude { "claude_link" } else { "codex_link" })
                            })
                            .and_then(Value::as_str)
                            .is_some_and(|old| Path::new(old) == linked)
                })
            {
                continue;
            }
            // Existing personal sources and directories are not implicitly managed.
            let same_install = entry.get("managed").and_then(Value::as_bool) == Some(true)
                && entry.get("installed_plugin_id").and_then(Value::as_i64)
                    == spec.installed_plugin_id;
            if !same_install || !self.matches_old_managed_copy(&target, entry)? {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin marketplace entry is occupied by an unrelated source",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn install_plugin_runtime_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        self.install_plugin_runtime_metadata_at(
            spec,
            store_path,
            manifest,
            &now_rfc3339_like(),
            None,
        )
    }

    fn install_plugin_runtime_metadata_at(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        manifest: &mut Value,
        timestamp: &str,
        publication: Option<&RecoveryJournal>,
    ) -> Result<(), CapabilitySyncError> {
        validate_package_identity(store_path, spec)?;
        checked_spec(
            &spec.key,
            &plugin_manifest_entry(
                spec,
                store_path,
                &self.plugin_runtime_link(spec),
                &self.plugin_codex_link(spec),
            ),
        )?;
        let _personal = if spec.marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE {
            Some(
                acquire_personal_marketplace_lock(&self.personal_marketplace_dir())
                    .map_err(CapabilitySyncError::invalid_payload)?,
            )
        } else {
            None
        };
        let old = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .cloned();
        for (path, field) in self.plugin_runtime_targets(spec) {
            self.ensure_runtime_path(&path, true)?;
            if exists(&path)
                && !old
                    .as_ref()
                    .is_some_and(|entry| entry_owns_path(entry, &path, field))
                && !shared_packages::owns_retained_plugin_runtime(manifest, &spec.key, &path)
            {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin runtime destination is occupied by an unmanaged item",
                ));
            }
        }
        let retained_entry = if old.is_none()
            && shared_packages::owns_retained_plugin_runtime(
                manifest,
                &spec.key,
                &self.plugin_codex_link(spec),
            ) {
            Some(plugin_manifest_entry(
                spec,
                store_path,
                &self.plugin_runtime_link(spec),
                &self.plugin_codex_link(spec),
            ))
        } else {
            None
        };
        self.validate_marketplace_occupancy(
            spec,
            old.as_ref()
                .or(retained_entry.as_ref())
                .unwrap_or(&Value::Null),
            manifest,
        )?;
        let (files, mut moved) = self.runtime_state_paths(spec);
        if !self.shared_packages {
            if let Some(old) = &old {
                moved.extend(self.current_recorded_runtime_paths(&spec.key, old)?);
            }
        }
        let superseded = if publication.is_none() && self.shared_packages {
            RecoveryJournal::pending_identity(self, &spec.key)?
        } else {
            None
        };
        let original = manifest.clone();
        let mut transaction = if publication.is_some() {
            None
        } else {
            Some(LocalPluginStateTransaction::begin(files, moved)?)
        };
        let result = (|| {
            if let Some(publication) = publication {
                self.publish_recovered_runtime_copies(spec, store_path)?;
                publication.publish_files(self)?;
            } else {
                if !self.codex_only_plugins {
                    self.install_claude_plugin_runtime_metadata_at(spec, store_path, timestamp)?;
                }
                let codex = self.plugin_codex_link(spec);
                copy_dir_atomic(store_path, &codex)?;
                ensure_dual_plugin_manifests(&codex)?;
                ensure_plugin_hook_permissions(&codex)?;
                self.install_codex_marketplace_metadata(spec, &codex)?;
            }
            let codex = self.plugin_codex_link(spec);
            let mut entry = old.clone().unwrap_or_else(|| json!({}));
            let mut fields =
                plugin_manifest_entry(spec, store_path, &self.plugin_runtime_link(spec), &codex);
            let mut runtime = entry
                .get("runtime")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            runtime.extend(fields["runtime"].as_object().unwrap().clone());
            if self.codex_only_plugins {
                runtime.remove("claude_link");
            }
            fields["runtime"] = Value::Object(runtime);
            ensure_root_object(&mut entry).extend(fields.as_object().unwrap().clone());
            entry
                .as_object_mut()
                .unwrap()
                .remove("runtime_recovery_error");
            if let Some(id) = &superseded {
                entry["runtime_recovery_superseded"] = json!(id);
            }
            if self.shared_packages {
                entry["previous"] = shared_packages::previous_for_hash(
                    old.as_ref(),
                    "checksum",
                    spec.checksum.as_deref(),
                );
                shared_packages::remember_plugin_runtime_owner(manifest, &spec.key, &entry);
                for (path, _) in self.plugin_runtime_targets(spec) {
                    ensure_object_field(manifest, "plugin_runtime_relocated_owners")
                        .remove(&path.to_string_lossy().into_owned());
                    ensure_object_field(manifest, "plugin_runtime_owner_origins")
                        .remove(&path.to_string_lossy().into_owned());
                }
            }
            ensure_object_field(manifest, "plugins").insert(spec.key.clone(), entry);
            if self.shared_packages {
                self.manifest.save_with_revision_bump(manifest.clone())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                if let Some(transaction) = transaction {
                    transaction.commit();
                }
                if let Some(id) = &superseded {
                    RecoveryJournal::archive_superseded(self, &spec.key, id)?;
                }
                Ok(())
            }
            Err(error) => {
                *manifest = original;
                if let Some(transaction) = &mut transaction {
                    Err(transaction.add_rollback_context(error))
                } else {
                    Err(error)
                }
            }
        }
    }

    fn publish_recovered_runtime_copies(
        &self,
        spec: &PluginSyncSpec,
        source: &Path,
    ) -> Result<(), CapabilitySyncError> {
        for (runtime, field) in self.plugin_runtime_targets(spec) {
            self.ensure_runtime_path(&runtime, true)?;
            copy_dir_atomic(source, &runtime)?;
            ensure_dual_plugin_manifests(&runtime)?;
            ensure_plugin_hook_permissions(&runtime)?;
            let claude = field == "claude_link";
            let market = if claude {
                self.claude_marketplace_dir(&spec.marketplace)
            } else {
                self.codex_marketplace_dir(&spec.marketplace)
            };
            let link = market
                .join("plugins")
                .join(self.marketplace_plugin_name(spec, claude));
            self.ensure_state_path(&link, true)?;
            link_or_copy_dir(&runtime, &link)?;
        }
        Ok(())
    }

    fn recovery_journal_path(&self, key: &str) -> PathBuf {
        self.manifest
            .path
            .parent()
            .unwrap_or(Path::new("."))
            .join(".plugin-runtime-recovery")
            .join(&sha256_digest(key.as_bytes())[7..])
    }

    fn recover_plugin_journal(
        &self,
        path: &Path,
        spec: &PluginSyncSpec,
        manifest: &Value,
    ) -> Result<(), CapabilitySyncError> {
        if !path.exists() {
            return Ok(());
        }
        if let Some(id) = RecoveryJournal::pending_identity(self, &spec.key)? {
            if manifest
                .get("plugins")
                .and_then(|plugins| plugins.get(&spec.key))
                .and_then(|entry| entry.get("runtime_recovery_superseded"))
                .and_then(Value::as_str)
                == Some(id.as_str())
            {
                return RecoveryJournal::archive_superseded(self, &spec.key, &id);
            }
        }
        let mut journal = RecoveryJournal::load(self, path, spec)?;
        let published = manifest
            .get("plugins")
            .and_then(|value| value.get(&spec.key))
            .and_then(|entry| entry.get("runtime_recovery_id"))
            .and_then(Value::as_str)
            == Some(journal.transaction_id.as_str());
        if published {
            journal.finish()
        } else {
            journal.rollback(self, spec)
        }
    }
}

fn checked_spec(key: &str, entry: &Value) -> Result<PluginSyncSpec, CapabilitySyncError> {
    let spec = PluginSyncSpec::from_manifest_entry(key, entry);
    for value in [&spec.name, &spec.marketplace, &spec.version] {
        shared_packages::validate_component(value)?;
    }
    if key != format!("{}@{}", spec.name, spec.marketplace) {
        return Err(CapabilitySyncError::invalid_payload(
            "Managed plugin identity does not match its key",
        ));
    }
    Ok(spec)
}

fn validate_package_identity(
    path: &Path,
    spec: &PluginSyncSpec,
) -> Result<(), CapabilitySyncError> {
    for manifest in [CODEX_PLUGIN_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH] {
        let source = path.join(manifest);
        if !source.is_file() {
            continue;
        }
        let value: Value = serde_json::from_slice(&fs::read(source)?)?;
        if value.get("name").and_then(Value::as_str) != Some(spec.name.as_str()) {
            return Err(CapabilitySyncError::invalid_payload(
                "Verified plugin package identity does not match the managed install",
            ));
        }
    }
    Ok(())
}

pub(super) fn safe_managed_path(
    root: &Path,
    path: &Path,
    leaf_link: bool,
) -> Result<(), CapabilitySyncError> {
    if !root.is_absolute()
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(CapabilitySyncError::invalid_payload(
            "Managed plugin path must be absolute without parent traversal",
        ));
    }
    let relative = path.strip_prefix(root).map_err(|_| {
        CapabilitySyncError::invalid_payload("Plugin path is outside its current managed root")
    })?;
    // The caller supplies the current configured root. Wework deliberately keeps
    // a relocated Claude home as an alias for its Keychain identity. Resolve only
    // that trusted anchor; symlinks below it remain forbidden.
    let root = if root.is_symlink() {
        fs::canonicalize(root)?
    } else {
        root.to_owned()
    };
    let target = root.join(relative);
    let mut current = root;
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            current.push(component);
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() && !(leaf_link && current == target) {
            return Err(CapabilitySyncError::invalid_payload(
                "Refusing to traverse a managed plugin path symlink",
            ));
        }
        if current != target && !metadata.is_dir() {
            return Err(CapabilitySyncError::invalid_payload(
                "Managed plugin parent is not a directory",
            ));
        }
    }
    Ok(())
}

fn exists(path: &Path) -> bool {
    path.exists() || path.is_symlink()
}

fn tree_fingerprint(path: &Path) -> Result<BTreeMap<PathBuf, String>, CapabilitySyncError> {
    fn visit(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<PathBuf, String>,
    ) -> Result<(), CapabilitySyncError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime ownership cannot be proved through a symlink",
            ));
        }
        if metadata.is_dir() {
            for child in fs::read_dir(path)? {
                visit(root, &child?.path(), result)?;
            }
        } else if metadata.is_file() {
            result.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                sha256_digest(&fs::read(path)?),
            );
        } else {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime contains a special file",
            ));
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    visit(path, path, &mut result)?;
    Ok(result)
}

fn same_runtime_contents(left: &Path, right: &Path) -> Result<bool, CapabilitySyncError> {
    if !left.is_dir() || left.is_symlink() || !right.is_dir() || right.is_symlink() {
        return Ok(false);
    }
    let mut left = tree_fingerprint(left)?;
    let right = tree_fingerprint(right)?;
    left.retain(|path, _| {
        !(path
            .components()
            .any(|component| component.as_os_str() == "__pycache__")
            && path.extension().is_some_and(|extension| extension == "pyc")
            && !right.contains_key(path))
    });
    Ok(left == right)
}

#[cfg(test)]
#[path = "runtime_recovery_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "runtime_recovery_startup_tests.rs"]
mod startup_tests;

#[cfg(test)]
#[path = "runtime_recovery_reinstall_tests.rs"]
mod reinstall_tests;
