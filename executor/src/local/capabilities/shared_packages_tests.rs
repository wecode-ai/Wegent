// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::{Cursor, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Clone)]
pub(super) struct Packages {
    skill: Vec<u8>,
    pub(super) plugin: Vec<u8>,
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
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { Ok(self.skill.clone()) })
    }
    fn download_plugin<'a>(
        &'a self,
        _path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
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

pub(super) fn store(root: &Path) -> GlobalCapabilityStore {
    let mut store = GlobalCapabilityStore::new(
        root.join("state/manifest-v2.json"),
        root.join("claude/skills"),
    )
    .with_plugins_dir(root.join("claude/plugins"))
    .with_codex_skills_dir(root.join("codex/skills"))
    .with_codex_plugins_dir(root.join("codex/plugins"))
    .with_workbench_root(root.join("workbench"));
    // This fixture covers both products, regardless of the executor launch environment.
    store.codex_only_plugins = false;
    store
}

#[cfg(unix)]
#[test]
fn publication_lock_releases_with_a_retained_descriptor() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let publication = store.lock_shared_manifest().unwrap().unwrap();
    // A concurrent fork can retain the same open file description.
    let inherited = publication.0.try_clone().unwrap();
    assert!(store.lock_shared_manifest().is_err());
    drop(publication);
    let next = store.lock_shared_manifest().unwrap().unwrap();
    assert!(store.lock_shared_manifest().is_err());
    drop(next);
    drop(inherited);
}

#[tokio::test]
async fn shared_sync_keeps_legacy_manifest_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let legacy = root.path().join("state/manifest.json");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let original = serde_json::to_vec(&default_manifest()).unwrap();
    fs::write(&legacy, &original).unwrap();
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let second = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v2"));
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
    assert_eq!(
        fs::read_link(store.skills_dir.join("example"))
            .unwrap()
            .is_relative(),
        cfg!(unix)
    );
}

#[tokio::test]
async fn wrong_skill_hash_preserves_current_entry() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let updated = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v2"));
    assert_eq!(
        updated.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
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
    // A fresh handler must recover ownership from disk after uninstall/restart.
    let reinstalled =
        CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v2"));
    assert_eq!(
        reinstalled.apply_sync(payload).await.unwrap()["success"],
        true
    );
    assert_eq!(
        fs::read_to_string(native.join("payload.txt")).unwrap(),
        "v2"
    );
    assert_eq!(
        fs::read_to_string(shared.join("payload.txt")).unwrap(),
        "v1"
    );
}

#[tokio::test]
async fn uninstall_remembers_runtime_ownership_from_existing_manifest() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
    let payload = json!({"scope":"plugins", "plugins":[{"name":"demo", "installed_plugin_id":1,
        "marketplace":"wegent", "version":"1.0", "download_path":"/package"}]});
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    let mut manifest = store.manifest.load().unwrap();
    manifest
        .as_object_mut()
        .unwrap()
        .remove("plugin_runtime_owners");
    store.manifest.save(manifest).unwrap();
    assert_eq!(
        handler
            .apply_sync(json!({"scope":"plugins", "plugins":[]}))
            .await
            .unwrap()["success"],
        true
    );
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
}

#[tokio::test]
async fn unmanaged_plugin_cache_is_not_adopted_from_another_owner() {
    for runtime in ["claude", "codex"] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let package =
            publish_plugin_archive(&root.path().join("workbench"), &packages.plugin, None).unwrap();
        let spec = PluginSyncSpec::from_value(&json!({"name":"demo", "installed_plugin_id":1,
            "marketplace":"wegent", "version":"1.0", "download_path":"/package", "checksum":package.archive_hash})).unwrap();
        let path = if runtime == "claude" {
            store.plugin_runtime_link(&spec)
        } else {
            store.plugin_codex_link(&spec)
        };
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("personal.txt"), "keep").unwrap();
        let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages);
        for owner in [None, Some("another@wegent")] {
            let mut manifest = default_manifest();
            if let Some(owner) = owner {
                ensure_object_field(&mut manifest, "plugin_runtime_owners")
                    .insert(path.to_string_lossy().into_owned(), json!(owner));
            }
            store.manifest.save(manifest).unwrap();
            let result = handler.apply_sync(json!({"scope":"plugins", "plugins":[{"name":"demo",
                "installed_plugin_id":1, "marketplace":"wegent", "version":"1.0", "download_path":"/package"}]})).await.unwrap();
            assert_eq!(result["success"], false);
            assert_eq!(
                result["plugins"][0]["error_code"],
                "PLUGIN_RUNTIME_METADATA_FAILED"
            );
            assert_eq!(
                fs::read_to_string(path.join("personal.txt")).unwrap(),
                "keep"
            );
        }
    }
}

#[tokio::test]
async fn sync_waits_for_execution_lease_before_changing_entry() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
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
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("new"));
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

#[derive(Clone)]
pub(super) struct CountedPackages {
    pub(super) package: Packages,
    pub(super) downloads: Arc<AtomicUsize>,
}

impl CapabilityPackageProvider for CountedPackages {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        self.package.stage_skill(spec, target)
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        self.package.download_plugin(path)
    }
}

pub(super) fn counted(version: &str) -> CountedPackages {
    CountedPackages {
        package: packages(version),
        downloads: Arc::new(AtomicUsize::new(0)),
    }
}

fn plugin_payload(packages: &CountedPackages) -> Value {
    json!({"mode":"merge", "plugins":[{"name":"demo", "installed_plugin_id":1,
        "marketplace":"wegent", "version":"1.0", "download_path":"/package",
        "checksum": crate::services::workbench::archive_hash(&packages.package.plugin)}]})
}

#[tokio::test]
async fn verified_cached_plugin_skips_download_and_preserves_metadata() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let payload = plugin_payload(&packages);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let mut signed_url = payload;
    signed_url["plugins"][0]["download_path"] = json!("/package?new-signature");
    assert_eq!(
        handler.apply_sync(signed_url).await.unwrap()["success"],
        true
    );
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
    let mut rewritten = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    // Rewrites refresh the timestamp even when nothing else changes.
    rewritten.as_object_mut().unwrap().remove("updated_at");
    let mut expected = entry;
    expected.as_object_mut().unwrap().remove("updated_at");
    assert_eq!(rewritten, expected);
    // installed_plugins.json is rewritten on every sync; only timestamps change.
    let mut installed = read_installed_plugins(&store.plugins_dir).unwrap();
    let record = installed["plugins"]["demo@wegent"][0]
        .as_object_mut()
        .unwrap();
    record.remove("installedAt");
    record.remove("lastUpdated");
    assert_eq!(
        record["checksum"],
        json!(crate::services::workbench::archive_hash(
            &packages.package.plugin
        ))
    );
    assert_eq!(record["version"], json!("1.0"));
}

#[tokio::test]
async fn runtime_drift_repairs_owned_and_generated_files_without_downloading() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let payload = plugin_payload(&packages);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    handler.apply_sync(payload.clone()).await.unwrap();
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let claude = PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap());
    let codex = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
    fs::write(claude.join("payload.txt"), "changed owned file").unwrap();
    fs::remove_file(codex.join(".codex-plugin/plugin.json")).unwrap();
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    assert_eq!(
        fs::read_to_string(claude.join("payload.txt")).unwrap(),
        "v1"
    );
    assert!(codex.join(".codex-plugin/plugin.json").is_file());
    fs::remove_dir_all(&codex).unwrap();
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    assert_eq!(fs::read_to_string(codex.join("payload.txt")).unwrap(), "v1");
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn metadata_changes_apply_without_redownloading() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let mut payload = plugin_payload(&packages);
    payload["plugins"][0]["cloud_plugin_id"] = json!(42);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    handler.apply_sync(payload.clone()).await.unwrap();
    payload["plugins"][0]["enabled"] = json!(false);
    payload["plugins"][0]["component_states"] = json!({"skills/demo": false});
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    // Identity fields from the earlier install survive a metadata-only sync.
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"]["cloud_plugin_id"],
        json!(42)
    );
    let installed = read_installed_plugins(&store.plugins_dir).unwrap();
    assert_eq!(
        installed["plugins"]["demo@wegent"][0]["componentStates"],
        json!({"skills/demo": false})
    );
    let settings = read_json_or_default(
        &store.plugins_dir.parent().unwrap().join("settings.json"),
        || json!({}),
    )
    .unwrap();
    assert_eq!(settings["enabledPlugins"]["demo@wegent"], false);
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn external_configuration_drift_is_repaired_without_downloading() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let payload = plugin_payload(&packages);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    handler.apply_sync(payload.clone()).await.unwrap();
    let settings_path = store.plugins_dir.parent().unwrap().join("settings.json");
    let mut settings = read_json_or_default(&settings_path, || json!({})).unwrap();
    settings["enabledPlugins"]["demo@wegent"] = json!(false);
    write_json(&settings_path, &settings).unwrap();
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    let repaired = read_json_or_default(&settings_path, || json!({})).unwrap();
    assert_eq!(repaired["enabledPlugins"]["demo@wegent"], true);
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn marketplace_identity_and_codex_product_drift_are_repaired_from_cache() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let payload = plugin_payload(&packages);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    handler.apply_sync(payload.clone()).await.unwrap();
    let claude_market = store.claude_marketplace_dir("wegent");
    let codex_market = store.codex_marketplace_dir("wegent");
    for path in [
        claude_market.join(".claude-plugin/marketplace.json"),
        claude_market.join(".agents/plugins/marketplace.json"),
        codex_market.join(".agents/plugins/marketplace.json"),
    ] {
        let mut marketplace = read_json_or_default(&path, || json!({})).unwrap();
        marketplace["name"] = json!("another-marketplace");
        write_json(&path, &marketplace).unwrap();
        assert_eq!(
            handler.apply_sync(payload.clone()).await.unwrap()["success"],
            true
        );
        assert_eq!(
            read_json_or_default(&path, || json!({})).unwrap()["name"],
            "wegent"
        );
    }
    let path = codex_market.join(".agents/plugins/marketplace.json");
    let mut marketplace = read_json_or_default(&path, || json!({})).unwrap();
    marketplace["plugins"][0]["policy"]["products"] = json!(["OTHER"]);
    write_json(&path, &marketplace).unwrap();
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    assert_eq!(
        read_json_or_default(&path, || json!({})).unwrap()["plugins"][0]["policy"]["products"],
        json!(["CODEX"])
    );
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn corrupt_cached_package_is_rejected_without_losing_runtime() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let payload = plugin_payload(&packages);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    handler.apply_sync(payload.clone()).await.unwrap();
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let source = PathBuf::from(entry["store_path"].as_str().unwrap());
    let runtime = PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap());
    fs::write(source.join("payload.txt"), "corrupt cache").unwrap();
    let original_manifest = store.manifest.load().unwrap();
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], false);
    assert_eq!(
        fs::read_to_string(runtime.join("payload.txt")).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(source.join("payload.txt")).unwrap(),
        "corrupt cache"
    );
    assert_eq!(
        store.manifest.load().unwrap()["plugins"],
        original_manifest["plugins"]
    );
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn same_version_content_change_downloads_new_hash_and_reinstall_reuses_it() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let first = counted("v1");
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), first.clone());
    handler.apply_sync(plugin_payload(&first)).await.unwrap();
    let second = counted("v2");
    let payload = plugin_payload(&second);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), second.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let runtime = PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap());
    assert_eq!(
        fs::read_to_string(runtime.join("payload.txt")).unwrap(),
        "v2"
    );
    assert_eq!(
        handler
            .apply_sync(json!({"scope":"plugins", "plugins":[]}))
            .await
            .unwrap()["success"],
        true
    );
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    assert_eq!(second.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_trusted_checksum_does_not_reuse_cache_before_download() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let mut payload = plugin_payload(&packages);
    payload["plugins"][0]
        .as_object_mut()
        .unwrap()
        .remove("checksum");
    let handler = CapabilitySyncHandler::with_package_provider("", store, packages.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    assert_eq!(handler.apply_sync(payload).await.unwrap()["success"], true);
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cached_package_noop_still_persists_ordering_fence() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = counted("v1");
    let mut payload = plugin_payload(&packages);
    payload["scope"] = json!("plugin_delta");
    payload["plugin_sync"] = json!({"version": 2, "generation": 1, "complete": false});
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    payload["plugin_sync"]["generation"] = json!(2);
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    let manifest = store.manifest.load().unwrap();
    assert_eq!(
        manifest["plugins"]["demo@wegent"]["plugin_sync_generation"],
        2
    );
    assert_eq!(
        manifest["plugin_sync"]["entries"]["demo@wegent"]["generation"],
        2
    );
    let late_removal = json!({"mode": "merge", "scope": "plugin_delta", "plugins": [],
        "removed_plugins": [payload["plugins"][0].clone()],
        "plugin_sync": {"version": 2, "generation": 1, "complete": false}});
    let result = handler.apply_sync(late_removal).await.unwrap();
    assert_eq!(result["plugins"][0]["status"], "superseded");
    assert!(store.manifest.load().unwrap()["plugins"]["demo@wegent"].is_object());
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}
