// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;

use super::*;
use crate::services::workbench::{
    link_package, publish_plugin_archive, publish_skill_archive, verify_published_package,
    workbench_root, PackageKind,
};

pub(super) struct ActivationRevision;

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
    fn shared_root(&self) -> Result<PathBuf, CapabilitySyncError> {
        match &self.workbench_root_override {
            Some(root) if root.is_absolute() => Ok(root.clone()),
            Some(_) => Err(CapabilitySyncError::invalid_payload(
                "Workbench home must be absolute",
            )),
            None => workbench_root().map_err(CapabilitySyncError::invalid_payload),
        }
    }

    pub(super) fn lock_shared_manifest(&self) -> Result<Option<fs::File>, CapabilitySyncError> {
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
        Ok(Some(file))
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
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, link)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(target, link)?;
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
        let previous = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .cloned();
        let mut installed_spec = spec.clone();
        let store_path = if let Some(download) = &spec.download_path {
            let bytes = self
                .package_provider
                .download_plugin(download)
                .await
                .map_err(|error| {
                    PluginSyncFailure::new("download", "PLUGIN_DOWNLOAD_FAILED", true, error)
                })?;
            let root = self
                .store
                .shared_root()
                .map_err(PluginSyncFailure::runtime_metadata)?;
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
            installed_spec.checksum = Some(package.archive_hash);
            package.path
        } else {
            let checksum = previous
                .as_ref()
                .and_then(|entry| entry.get("checksum"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PluginSyncFailure::new(
                        "package",
                        "PLUGIN_PACKAGE_UNAVAILABLE",
                        true,
                        CapabilitySyncError::invalid_payload(
                            "Plugin has no verified package or download URL",
                        ),
                    )
                })?;
            if spec
                .checksum
                .as_deref()
                .is_some_and(|expected| expected != checksum)
            {
                return Err(PluginSyncFailure::runtime_metadata(
                    CapabilitySyncError::invalid_payload(
                        "Changed plugin checksum requires a download URL",
                    ),
                ));
            }
            let root = self
                .store
                .shared_root()
                .map_err(PluginSyncFailure::runtime_metadata)?;
            let package = verify_published_package(&root, PackageKind::Plugin, checksum).map_err(
                |error| {
                    PluginSyncFailure::runtime_metadata(CapabilitySyncError::invalid_payload(error))
                },
            )?;
            installed_spec.checksum = Some(package.archive_hash);
            package.path
        };
        for (path, field) in [
            (
                self.store.plugin_runtime_link(&installed_spec),
                "claude_link",
            ),
            (self.store.plugin_codex_link(&installed_spec), "codex_link"),
        ] {
            if occupied_unmanaged(&path, previous.as_ref(), field) {
                return Err(PluginSyncFailure::runtime_metadata(
                    CapabilitySyncError::invalid_payload(
                        "Plugin path is occupied by an unmanaged item",
                    ),
                ));
            }
        }
        self.store
            .install_plugin_runtime_metadata(&installed_spec, &store_path, manifest)
            .map_err(PluginSyncFailure::runtime_metadata)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[derive(Clone)]
    struct Packages {
        skill: Vec<u8>,
        plugin: Vec<u8>,
    }

    impl CapabilityPackageProvider for Packages {
        fn stage_skill<'a>(
            &'a self,
            _spec: &'a SkillSyncSpec,
            _target: &'a Path,
        ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
            Box::pin(async { panic!("shared sync must request archive bytes") })
        }
        fn download_skill<'a>(
            &'a self,
            _spec: &'a SkillSyncSpec,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>>
        {
            Box::pin(async { Ok(self.skill.clone()) })
        }
        fn download_plugin<'a>(
            &'a self,
            _path: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>>
        {
            Box::pin(async { Ok(self.plugin.clone()) })
        }
    }

    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, text) in entries {
            writer
                .start_file(*path, zip::write::FileOptions::default())
                .unwrap();
            writer.write_all(text.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn packages(version: &str) -> Packages {
        Packages {
            skill: archive(&[("SKILL.md", version)]),
            plugin: archive(&[
                (
                    ".claude-plugin/plugin.json",
                    "{\"name\":\"demo\",\"version\":\"1.0\"}",
                ),
                ("payload.txt", version),
            ]),
        }
    }

    fn store(root: &Path) -> GlobalCapabilityStore {
        GlobalCapabilityStore::new(
            root.join("state/manifest-v2.json"),
            root.join("claude/skills"),
        )
        .with_plugins_dir(root.join("claude/plugins"))
        .with_codex_skills_dir(root.join("codex/skills"))
        .with_codex_plugins_dir(root.join("codex/plugins"))
        .with_workbench_root(root.join("workbench"))
    }

    #[tokio::test]
    async fn shared_sync_keeps_legacy_manifest_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let legacy = root.path().join("state/manifest.json");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let original = serde_json::to_vec(&default_manifest()).unwrap();
        fs::write(&legacy, &original).unwrap();
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        let result = handler
            .apply_sync(json!({"skills":[{"name":"example","skill_id":1}]}))
            .await
            .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(fs::read(legacy).unwrap(), original);
        assert_eq!(store.manifest.load().unwrap()["version"], 2);
        assert!(store.manifest.load().unwrap()["skills"]["example"]["store_path"].is_string());
    }

    #[tokio::test]
    async fn connector_generator_namespace_cannot_point_into_shared_packages() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        let result = handler
            .apply_sync(json!({"skills":[{"name":"wegent-connector-demo","skill_id":1}]}))
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert!(!store.skills_dir.join("wegent-connector-demo").exists());
        assert!(!store
            .codex_skills_dir
            .join("wegent-connector-demo")
            .exists());
        assert!(!root.path().join("workbench/shared/skills").exists());
    }

    #[tokio::test]
    async fn skill_updates_publish_new_hash_and_retain_old_package() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let payload = json!({"skills":[{"name":"example", "skill_id":1}]});
        let first = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        assert_eq!(
            first.apply_sync(payload.clone()).await.unwrap()["success"],
            true
        );
        let old = store.manifest.load().unwrap()["skills"]["example"].clone();
        let second =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v2"));
        assert_eq!(second.apply_sync(payload).await.unwrap()["success"], true);
        let current = store.manifest.load().unwrap()["skills"]["example"].clone();
        assert_ne!(old["store_path"], current["store_path"]);
        assert_eq!(current["previous"]["store_path"], old["store_path"]);
        assert_eq!(
            fs::read_to_string(Path::new(old["store_path"].as_str().unwrap()).join("SKILL.md"))
                .unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(store.codex_skills_dir.join("example/SKILL.md")).unwrap(),
            "v2"
        );
        assert!(fs::read_link(store.skills_dir.join("example"))
            .unwrap()
            .is_relative());
    }

    #[tokio::test]
    async fn wrong_skill_hash_preserves_current_entry() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        handler
            .apply_sync(json!({"skills":[{"name":"example", "skill_id":1}]}))
            .await
            .unwrap();
        let old = store.manifest.load().unwrap()["skills"]["example"].clone();
        let result = handler
            .apply_sync(
                json!({"skills":[{"name":"example", "skill_id":1, "content_hash":"sha256:bad"}]}),
            )
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(store.manifest.load().unwrap()["skills"]["example"], old);
        assert_eq!(
            fs::read_to_string(store.skills_dir.join("example/SKILL.md")).unwrap(),
            "v1"
        );
    }

    #[tokio::test]
    async fn unmanaged_codex_skill_and_symlink_are_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let target = store.codex_skills_dir.join("example");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "user").unwrap();
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        let result = handler
            .apply_sync(json!({"skills":[{"name":"example", "skill_id":1}]}))
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "user");
        assert!(!root.path().join("workbench/shared/skills").exists());
    }

    #[tokio::test]
    async fn plugin_caches_are_writable_copies_and_shared_packages_survive_removal() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let payload = json!({"scope":"plugins", "plugins":[{"name":"demo", "installed_plugin_id":1,
            "marketplace":"wegent", "version":"1.0", "download_path":"/package"}]});
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        assert_eq!(
            handler.apply_sync(payload.clone()).await.unwrap()["success"],
            true
        );
        let old = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
        let shared = PathBuf::from(old["store_path"].as_str().unwrap());
        let native = PathBuf::from(old["runtime"]["codex_link"].as_str().unwrap());
        assert_eq!(native.file_name().unwrap(), "1.0");
        assert!(!native.is_symlink());
        assert!(native.join(".codex-plugin/plugin.json").exists());
        assert!(!shared.join(".codex-plugin/plugin.json").exists());
        fs::write(native.join("native-cache-only.txt"), "mutable").unwrap();
        assert!(!shared.join("native-cache-only.txt").exists());
        let claude_native = PathBuf::from(old["runtime"]["claude_link"].as_str().unwrap());
        assert!(!claude_native.is_symlink());
        fs::write(claude_native.join("native-cache-only.txt"), "mutable").unwrap();
        assert!(!shared.join("native-cache-only.txt").exists());
        let updated =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v2"));
        assert_eq!(updated.apply_sync(payload).await.unwrap()["success"], true);
        let current = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
        assert_eq!(
            old["runtime"]["codex_link"],
            current["runtime"]["codex_link"]
        );
        assert_eq!(
            fs::read_to_string(native.join("payload.txt")).unwrap(),
            "v2"
        );
        assert_ne!(old["store_path"], current["store_path"]);
        assert_eq!(
            fs::read_to_string(shared.join("payload.txt")).unwrap(),
            "v1"
        );
        updated
            .apply_sync(json!({"scope":"plugins", "plugins":[]}))
            .await
            .unwrap();
        assert!(shared.exists());
        assert!(native.exists());
        assert!(store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn sync_waits_for_execution_lease_before_changing_entry() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
        let payload = json!({"skills":[{"name":"example", "skill_id":1}]});
        let lease = crate::services::capability_activation::begin_execution().await;
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(20),
            handler.apply_sync(payload.clone())
        )
        .await
        .is_err());
        assert!(!store.skills_dir.join("example").exists());
        drop(lease);
        assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    }

    #[tokio::test]
    async fn managed_directory_is_migrated_and_retained_outside_skill_discovery() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let old = store.skills_dir.join("example");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("SKILL.md"), "legacy copy").unwrap();
        store
            .manifest
            .save(json!({"skills":{"example":{
                "managed":true, "name":"example", "skill_id":1,
                "runtime":{"claude_link":old}
            }}}))
            .unwrap();
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages("new"));
        assert_eq!(
            handler
                .apply_sync(json!({"skills":[{"name":"example", "skill_id":1}]}))
                .await
                .unwrap()["success"],
            true
        );
        assert_eq!(fs::read_to_string(old.join("SKILL.md")).unwrap(), "new");
        let manifest = store.manifest.load().unwrap();
        let recovery = PathBuf::from(
            manifest["skills"]["example"]["recovery_paths"][0]
                .as_str()
                .unwrap(),
        );
        assert!(!recovery.starts_with(&store.skills_dir));
        assert_eq!(
            fs::read_to_string(recovery.join("SKILL.md")).unwrap(),
            "legacy copy"
        );
    }

    #[test]
    fn failed_manifest_commit_restores_managed_directory() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("home/skills/example");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("SKILL.md"), "new").unwrap();
        fs::write(target.join("SKILL.md"), "old").unwrap();
        let error = switch_skill_links(&source, std::slice::from_ref(&target), |_| {
            Err(CapabilitySyncError::invalid_payload(
                "simulated manifest failure",
            ))
        })
        .unwrap_err();
        assert!(error.to_string().contains("simulated manifest failure"));
        assert!(!target.is_symlink());
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "old");
    }
}
