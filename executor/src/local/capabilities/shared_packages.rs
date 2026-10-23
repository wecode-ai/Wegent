// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use std::time::Instant;

use super::*;
use crate::services::workbench::{
    link_package, publish_plugin_archive, publish_skill_archive, verify_published_package,
    workbench_root, PackageKind,
};

pub(super) struct ActivationRevision;

pub(super) struct PublicationLock(fs::File);

impl Drop for PublicationLock {
    fn drop(&mut self) {
        // A concurrent fork can retain the open file description after sync ends.
        let _ = FileExt::unlock(&self.0);
    }
}

pub(super) fn validate_component(value: &str) -> Result<(), CapabilitySyncError> {
    if value.is_empty()
        || value != value.trim()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', ':', '\0'])
    {
        return Err(CapabilitySyncError::invalid_payload(
            "Invalid capability path component",
        ));
    }
    Ok(())
}

impl Drop for ActivationRevision {
    fn drop(&mut self) {
        // Even a partially successful sync can change native configuration.
        crate::services::capability_activation::mark_changed();
    }
}

impl GlobalCapabilityStore {
    pub(super) fn shared_root(&self) -> Result<PathBuf, CapabilitySyncError> {
        match &self.workbench_root_override {
            Some(root) if root.is_absolute() => Ok(root.clone()),
            Some(_) => Err(CapabilitySyncError::invalid_payload(
                "Workbench home must be absolute",
            )),
            None => workbench_root().map_err(CapabilitySyncError::invalid_payload),
        }
    }

    pub(super) fn lock_shared_manifest(
        &self,
    ) -> Result<Option<PublicationLock>, CapabilitySyncError> {
        if !self.shared_packages {
            return Ok(None);
        }
        self.shared_root()?;
        let parent = self.manifest.path.parent().ok_or_else(|| {
            CapabilitySyncError::invalid_payload("Capability manifest has no parent directory")
        })?;
        fs::create_dir_all(parent)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(parent.join(".sync.lock"))?;
        // Do not block an async executor thread behind a different process.
        file.try_lock_exclusive().map_err(|error| {
            CapabilitySyncError::invalid_payload(format!(
                "Capability publication is locked: {error}"
            ))
        })?;
        Ok(Some(PublicationLock(file)))
    }
}

fn occupied_unmanaged(path: &Path, entry: Option<&Value>, field: &str) -> bool {
    if !path.exists() && !path.is_symlink() {
        return false;
    }
    !entry.is_some_and(|entry| {
        entry.get("managed").and_then(Value::as_bool) == Some(true)
            && [Some(entry), entry.get("previous")]
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry
                        .get("runtime")
                        .and_then(|runtime| runtime.get(field))
                        .and_then(Value::as_str)
                        .is_some_and(|value| same_entry(Path::new(value), path))
                })
    })
}

fn same_entry(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    left.file_name() == right.file_name()
        && left.parent().zip(right.parent()).is_some_and(|(a, b)| {
            fs::canonicalize(a)
                .ok()
                .zip(fs::canonicalize(b).ok())
                .is_some_and(|(a, b)| a == b)
        })
}

pub(super) fn remember_plugin_runtime_owner(manifest: &mut Value, key: &str, plugin: &Value) {
    if plugin.get("managed").and_then(Value::as_bool) != Some(true) {
        return;
    }
    let owners = ensure_object_field(manifest, "plugin_runtime_owners");
    for entry in [Some(plugin), plugin.get("previous")].into_iter().flatten() {
        for field in ["claude_link", "codex_link"] {
            if let Some(path) = entry
                .get("runtime")
                .and_then(|runtime| runtime.get(field))
                .and_then(Value::as_str)
            {
                owners.insert(path.to_owned(), json!(key));
            }
        }
    }
}

pub(super) fn owns_retained_plugin_runtime(manifest: &Value, key: &str, path: &Path) -> bool {
    manifest
        .get("plugin_runtime_owners")
        .and_then(Value::as_object)
        .is_some_and(|owners| {
            owners.iter().any(|(owned_path, owner)| {
                owner.as_str() == Some(key) && same_entry(Path::new(owned_path), path)
            })
        })
}

pub(super) fn managed_descendant(root: &Path, path: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }
    fs::canonicalize(root)
        .ok()
        .zip(fs::canonicalize(path).ok())
        .is_some_and(|(root, path)| path.starts_with(root))
}

fn previous_version(entry: Option<&Value>) -> Value {
    let mut previous = entry.cloned().unwrap_or(Value::Null);
    if let Some(object) = previous.as_object_mut() {
        object.remove("previous");
    }
    previous
}

pub(super) fn previous_for_hash(entry: Option<&Value>, field: &str, hash: Option<&str>) -> Value {
    if entry
        .and_then(|entry| entry.get(field))
        .and_then(Value::as_str)
        == hash
    {
        entry
            .and_then(|entry| entry.get("previous"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        previous_version(entry)
    }
}

enum SkillBackup {
    Missing,
    Link(PathBuf),
    Directory(PathBuf),
}

fn restore_skill_entry(link: &Path, backup: &SkillBackup) -> Result<(), CapabilitySyncError> {
    remove_existing_path(link)?;
    match backup {
        SkillBackup::Missing => Ok(()),
        SkillBackup::Directory(path) => {
            fs::rename(path, link)?;
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir_all(parent);
            }
            Ok(())
        }
        SkillBackup::Link(target) => {
            crate::directory_link::create(target, link)?;
            Ok(())
        }
    }
}

fn install_skill_entry(source: &Path, link: &Path) -> Result<(), CapabilitySyncError> {
    // Do not turn a failed symlink privilege check into destructive copy fallback.
    link_package(source, link).map_err(CapabilitySyncError::invalid_payload)
}

fn manifest_retains_recovery(entry: Option<&Value>, backup: &Path) -> bool {
    entry.is_some_and(|entry| {
        entry
            .get("recovery_paths")
            .and_then(Value::as_array)
            .is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| path.as_str().is_some_and(|path| Path::new(path) == backup))
            })
            || manifest_retains_recovery(entry.get("previous"), backup)
    })
}

fn recover_skill_entry(link: &Path, entry: Option<&Value>) -> Result<(), CapabilitySyncError> {
    let Some(home) = link.parent().and_then(Path::parent) else {
        return Ok(());
    };
    let root = home.join(".capability-recovery/skills");
    if !root.is_dir() {
        return Ok(());
    }
    for recovery in fs::read_dir(root)? {
        let recovery = recovery?.path();
        let journal = recovery.join("recovery.json");
        if !journal.is_file() {
            continue;
        }
        let mut record: Value = serde_json::from_slice(&fs::read(&journal)?)?;
        if record.get("target").and_then(Value::as_str).map(Path::new) != Some(link)
            || record.get("state").and_then(Value::as_str) == Some("retained")
        {
            continue;
        }
        let backup = recovery.join("entry");
        if manifest_retains_recovery(entry, &backup) {
            record["state"] = json!("retained");
            write_json(&journal, &record)?;
            continue;
        }
        if !backup.is_dir() {
            continue;
        }
        if link.exists() || link.is_symlink() {
            let expected_source = record
                .get("source")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .and_then(|path| fs::canonicalize(path).ok());
            if !link.is_symlink() || fs::canonicalize(link).ok() != expected_source {
                return Err(CapabilitySyncError::invalid_payload(format!(
                    "Interrupted skill migration has conflicting runtime data; original retained at {}", backup.display()
                )));
            }
        }
        restore_skill_entry(link, &SkillBackup::Directory(backup))?;
    }
    Ok(())
}

fn switch_skill_links(
    source: &Path,
    links: &[PathBuf],
    publish: impl FnOnce(&[PathBuf]) -> Result<(), CapabilitySyncError>,
) -> Result<(), CapabilitySyncError> {
    let mut backups = Vec::new();
    let mut retained = Vec::new();
    let result = (|| {
        for link in links {
            let backup = if link.is_symlink() {
                SkillBackup::Link(fs::read_link(link)?)
            } else if link.is_dir() {
                let parent = link.parent().ok_or_else(|| {
                    CapabilitySyncError::invalid_payload("Skill entry has no parent")
                })?;
                let recovery_root = parent
                    .parent()
                    .unwrap_or(parent)
                    .join(".capability-recovery/skills");
                fs::create_dir_all(&recovery_root)?;
                let recovery = tempfile::Builder::new()
                    .prefix("previous-")
                    .tempdir_in(&recovery_root)?
                    .keep();
                let old_entry = recovery.join("entry");
                write_json(
                    &recovery.join("recovery.json"),
                    &json!({
                        "target": link, "backup": old_entry, "source": source, "state": "prepared",
                    }),
                )?;
                fs::rename(link, &old_entry)?;
                retained.push(old_entry.clone());
                SkillBackup::Directory(old_entry)
            } else if link.exists() {
                return Err(CapabilitySyncError::invalid_payload(
                    "Managed skill entry is not a directory",
                ));
            } else {
                SkillBackup::Missing
            };
            // Register the backup before publication, including failures to create
            // Windows links, so the original directory is always recoverable.
            backups.push((link, backup));
            if let Err(error) = install_skill_entry(source, link) {
                // Failed creation leaves pre-existing symlinks untouched. Only a
                // real directory moved above needs restoration for this entry.
                if !matches!(backups.last(), Some((_, SkillBackup::Directory(_)))) {
                    backups.pop();
                }
                return Err(error);
            }
        }
        publish(&retained)
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (link, backup) in backups.iter().rev() {
            if let Err(error) = restore_skill_entry(link, backup) {
                failures.push(error.to_string());
            }
        }
        if !failures.is_empty() {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "{error}; skill entry rollback failed: {}",
                failures.join("; ")
            )));
        }
        return Err(error);
    }
    Ok(())
}

impl<P: CapabilityPackageProvider> CapabilitySyncHandler<P> {
    pub(super) async fn try_sync_shared_skill(
        &self,
        spec: &SkillSyncSpec,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        // Connector generators overwrite these files in place, including older executors.
        if spec.name.starts_with("wegent-connector-") {
            return Err(CapabilitySyncError::invalid_payload(
                "Generated connector skills must remain private writable directories, not shared package links",
            ));
        }
        let links = [
            self.store.skills_dir.join(&spec.name),
            self.store.codex_skills_dir.join(&spec.name),
        ];
        let previous = manifest
            .get("skills")
            .and_then(|skills| skills.get(&spec.name))
            .cloned();
        for (link, field) in links.iter().zip(["claude_link", "codex_link"]) {
            if previous
                .as_ref()
                .and_then(|entry| entry.get("managed"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                recover_skill_entry(link, previous.as_ref())?;
            }
            if occupied_unmanaged(link, previous.as_ref(), field) {
                return Err(CapabilitySyncError::invalid_payload(
                    "Skill path is occupied by an unmanaged item",
                ));
            }
        }
        let bytes = self.package_provider.download_skill(spec).await?;
        let root = self.store.shared_root()?;
        let package = publish_skill_archive(&root, &bytes, spec.content_hash.as_deref())
            .map_err(CapabilitySyncError::invalid_payload)?;
        let previous = previous_for_hash(
            previous.as_ref(),
            "content_hash",
            Some(&package.archive_hash),
        );
        let original = manifest.clone();
        ensure_object_field(manifest, "skills").insert(
            spec.name.clone(),
            json!({
                "managed": true, "name": spec.name, "skill_id": spec.skill_id,
                "namespace": spec.namespace, "is_public": spec.is_public,
                "content_hash": package.archive_hash, "store_path": package.path,
                "runtime": { "claude_link": links[0], "codex_link": links[1] },
                "previous": previous, "updated_at": now_rfc3339_like(),
            }),
        );
        if let Err(error) = switch_skill_links(&package.path, &links, |recovery_paths| {
            if !recovery_paths.is_empty() {
                manifest["skills"][&spec.name]["recovery_paths"] = json!(recovery_paths);
            }
            self.store
                .manifest
                .save_with_revision_bump(manifest.clone())
        }) {
            *manifest = original;
            return Err(error);
        }
        Ok(())
    }

    pub(super) async fn try_sync_shared_plugin(
        &self,
        spec: &PluginSyncSpec,
        manifest: &mut Value,
    ) -> Result<(), PluginSyncFailure> {
        let started = Instant::now();
        let previous = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .cloned();
        let mut installed_spec = spec.clone();
        let root = self
            .store
            .shared_root()
            .map_err(PluginSyncFailure::runtime_metadata)?;
        // The server checksum, not a version label or signed download URL, is the
        // authority for reuse. Unchecksummed URLs must still be downloaded.
        let expected = spec.checksum.as_deref().or_else(|| {
            if spec.download_path.is_none() {
                previous.as_ref()?.get("checksum")?.as_str()
            } else {
                None
            }
        });
        let verify_started = Instant::now();
        let cached = expected.and_then(|checksum| {
            verify_published_package(&root, PackageKind::Plugin, checksum).ok()
        });
        let verify_ms = verify_started.elapsed().as_millis();
        let cache_hit = cached.is_some();
        let mut download_ms = 0;
        let mut download_bytes = 0;
        let mut package_ms = 0;
        let package = if let Some(package) = cached {
            package
        } else if let Some(download) = &spec.download_path {
            let download_started = Instant::now();
            let bytes = self
                .package_provider
                .download_plugin(download)
                .await
                .map_err(|error| {
                    PluginSyncFailure::new("download", "PLUGIN_DOWNLOAD_FAILED", true, error)
                })?;
            download_ms = download_started.elapsed().as_millis();
            download_bytes = bytes.len();
            let package_started = Instant::now();
            let package = publish_plugin_archive(&root, &bytes, spec.checksum.as_deref()).map_err(
                |error| {
                    PluginSyncFailure::new(
                        "package",
                        "PLUGIN_PACKAGE_INTEGRITY_FAILED",
                        false,
                        CapabilitySyncError::invalid_payload(error),
                    )
                },
            )?;
            package_ms = package_started.elapsed().as_millis();
            package
        } else {
            return Err(PluginSyncFailure::new(
                "package",
                "PLUGIN_PACKAGE_UNAVAILABLE",
                true,
                CapabilitySyncError::invalid_payload(
                    "Plugin has no verified package or download URL",
                ),
            ));
        };
        installed_spec.checksum = Some(package.archive_hash);
        let store_path = package.path;
        self.store
            .prepare_relocated_runtime_ownership(&installed_spec, &store_path, manifest)
            .map_err(PluginSyncFailure::runtime_metadata)?;
        for (path, field) in self.store.plugin_runtime_targets(&installed_spec) {
            if occupied_unmanaged(&path, previous.as_ref(), field)
                && !owns_retained_plugin_runtime(manifest, &spec.key, &path)
            {
                return Err(PluginSyncFailure::runtime_metadata(
                    CapabilitySyncError::invalid_payload(
                        "Plugin path is occupied by an unmanaged item",
                    ),
                ));
            }
        }
        let runtime_started = Instant::now();
        self.store
            .install_plugin_runtime_metadata(&installed_spec, &store_path, manifest)
            .map_err(PluginSyncFailure::runtime_metadata)?;
        crate::logging::log_executor_event(
            "plugin_materialized",
            &[
                ("plugin", spec.key.clone()),
                ("cache_hit", cache_hit.to_string()),
                ("verify_ms", verify_ms.to_string()),
                ("download_ms", download_ms.to_string()),
                ("download_bytes", download_bytes.to_string()),
                ("package_ms", package_ms.to_string()),
                (
                    "runtime_ms",
                    runtime_started.elapsed().as_millis().to_string(),
                ),
                ("total_ms", started.elapsed().as_millis().to_string()),
            ],
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "shared_packages_tests.rs"]
mod tests;
