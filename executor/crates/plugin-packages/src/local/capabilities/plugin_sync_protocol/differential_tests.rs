// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Default)]
struct Packages(AtomicUsize);

impl CapabilityPackageProvider for Packages {
    fn stage_skill<'a>(
        &'a self,
        _: &'a SkillSyncSpec,
        _: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { panic!("No standalone skills in this fixture") })
    }
    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(archive(path.rsplit('/').next().unwrap()))
        })
    }
}

fn archive(name: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new_append(Cursor::new(package(name))).unwrap();
    for (path, text) in [
        (
            "skills/demo/SKILL.md",
            "---\nname: demo\ndescription: Demo\n---\nA skill",
        ),
        ("hooks/start.sh", "#!/bin/sh\nexit 0\n"),
    ] {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(text.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn desired(name: &str, id: i64) -> Value {
    let mut value = plugin(name, id);
    value["checksum"] = json!(sha256_digest(&archive(name)));
    value
}

fn shared_fixture(codex_only: bool) -> (tempfile::TempDir, CapabilitySyncHandler<Packages>) {
    let root = tempfile::tempdir().unwrap();
    let mut store = GlobalCapabilityStore::new(
        root.path().join("state/manifest-v2.json"),
        root.path().join("claude/skills"),
    )
    .with_plugins_dir(root.path().join("claude/plugins"))
    .with_codex_plugins_dir(root.path().join("codex/plugins"))
    .with_workbench_root(root.path().join("workbench"));
    store.codex_only_plugins = codex_only;
    (
        root,
        CapabilitySyncHandler::with_package_provider(
            "test",
            store,
            Packages::default(),
            std::sync::Arc::new(crate::NoRunningSessions),
        ),
    )
}

#[tokio::test]
async fn personal_marketplace_publishes_one_entry_for_both_runtimes() {
    for shared in [false, true] {
        for codex_only in [true, false] {
            let (root, mut handler) = shared_fixture(codex_only);
            if !shared {
                handler.store = handler
                    .store
                    .clone()
                    .with_store_dir(root.path().join("private-store"));
                handler.store.shared_packages = false;
            }
            let mut desired = desired("alpha", 1);
            desired["marketplace"] = json!(PERSONAL_SHARED_PLUGIN_MARKETPLACE);
            let spec = PluginSyncSpec::from_value(&desired).unwrap();
            let result = handler
                .apply_sync(complete(10, vec![desired.clone()]))
                .await
                .unwrap();
            assert_eq!(result["success"], true, "{result}");
            let entry = handler
                .store
                .personal_marketplace_dir()
                .join("plugins/alpha");
            assert!(entry.join(CODEX_PLUGIN_MANIFEST_PATH).is_file());
            assert!(entry.join(CLAUDE_PLUGIN_MANIFEST_PATH).is_file());
            #[cfg(unix)]
            assert_eq!(
                fs::read_link(&entry).unwrap(),
                handler.store.plugin_codex_link(&spec)
            );
            for (runtime, _) in handler.store.plugin_runtime_targets(&spec) {
                assert!(runtime.join(CODEX_PLUGIN_MANIFEST_PATH).is_file());
                assert!(runtime.join(CLAUDE_PLUGIN_MANIFEST_PATH).is_file());
            }
            let repeated = handler
                .apply_sync(complete(11, vec![desired.clone()]))
                .await
                .unwrap();
            assert_eq!(repeated["success"], true, "{repeated}");
            if shared {
                assert_eq!(repeated["plugins"][0]["unchanged"], true, "{repeated}");
            }
            assert!(entry.join(CODEX_PLUGIN_MANIFEST_PATH).is_file());
            #[cfg(unix)]
            {
                let unrelated = root.path().join("unrelated");
                fs::create_dir_all(&unrelated).unwrap();
                fs::write(unrelated.join("marker"), "unmanaged content").unwrap();
                fs::remove_file(&entry).unwrap();
                std::os::unix::fs::symlink(&unrelated, &entry).unwrap();
                let rejected = handler
                    .apply_sync(complete(12, vec![desired]))
                    .await
                    .unwrap();
                assert_eq!(rejected["success"], false, "{rejected}");
                assert_eq!(fs::read_link(&entry).unwrap(), unrelated);
                assert_eq!(
                    fs::read_to_string(unrelated.join("marker")).unwrap(),
                    "unmanaged content"
                );
            }
        }
    }
}

#[tokio::test]
#[cfg(unix)]
async fn personal_marketplace_repairs_an_owned_claude_target_after_recovery() {
    let (_root, handler) = shared_fixture(false);
    let mut desired = desired("alpha", 1);
    desired["marketplace"] = json!(PERSONAL_SHARED_PLUGIN_MARKETPLACE);
    let spec = PluginSyncSpec::from_value(&desired).unwrap();
    let installed = handler
        .apply_sync(complete(10, vec![desired.clone()]))
        .await
        .unwrap();
    assert_eq!(installed["success"], true, "{installed}");
    let entry = handler
        .store
        .personal_marketplace_dir()
        .join("plugins/alpha");
    let claude = handler.store.plugin_runtime_link(&spec);
    fs::remove_file(&entry).unwrap();
    std::os::unix::fs::symlink(&claude, &entry).unwrap();
    fs::write(claude.join("payload.txt"), "damaged owned payload").unwrap();
    let repaired = handler
        .apply_sync(complete(11, vec![desired]))
        .await
        .unwrap();
    assert_eq!(repaired["success"], true, "{repaired}");
    assert_eq!(
        fs::read_to_string(entry.join("payload.txt")).unwrap(),
        "valid plugin contents"
    );
}

#[tokio::test]
async fn identical_complete_inventory_skips_installation_and_preserves_ordering() {
    for codex_only in [true, false] {
        let (_root, handler) = shared_fixture(codex_only);
        let desired = desired("alpha", 1);
        assert_eq!(
            handler
                .apply_sync(complete(10, vec![desired.clone()]))
                .await
                .unwrap()["success"],
            true
        );
        let spec = PluginSyncSpec::from_value(&desired).unwrap();
        let files = handler
            .store
            .runtime_state_paths(&spec)
            .0
            .into_iter()
            .map(|path| {
                (
                    path.clone(),
                    fs::read(&path).unwrap(),
                    fs::metadata(&path).unwrap().modified().unwrap(),
                )
            })
            .collect::<Vec<_>>();

        let result = handler
            .apply_sync(complete(11, vec![desired.clone()]))
            .await
            .unwrap();

        assert_eq!(result["plugins"][0]["unchanged"], true, "{result}");
        assert_eq!(result["changed"], false);
        assert_eq!(result["requires_restart"], false);
        assert_eq!(handler.package_provider.0.load(Ordering::SeqCst), 1);
        for (path, bytes, modified) in files {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        }
        let stale = handler
            .apply_sync(delta(10, vec![], vec![desired]))
            .await
            .unwrap();
        assert_eq!(stale["plugins"][0]["status"], "superseded");
    }
}

#[tokio::test]
async fn only_changed_plugins_are_synchronized_and_omitted_plugins_are_removed() {
    let (_root, handler) = shared_fixture(true);
    let a = desired("alpha", 1);
    let mut b = desired("beta", 2);
    let c = desired("gamma", 3);
    let d = desired("delta", 4);
    handler
        .apply_sync(complete(10, vec![a.clone(), b.clone(), c]))
        .await
        .unwrap();
    b["enabled"] = json!(false);
    let result = handler
        .apply_sync(complete(11, vec![a.clone(), b.clone(), d.clone()]))
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    let results = result["plugins"].as_array().unwrap();
    assert!(results
        .iter()
        .any(|item| item["name"] == "alpha" && item["unchanged"] == true));
    assert!(results.iter().any(|item| item["name"] == "beta"
        && item["unchanged"] != true
        && item["status"] == "synced"));
    assert!(results
        .iter()
        .any(|item| item["name"] == "gamma" && item["status"] == "removed"));
    assert!(results.iter().any(|item| item["name"] == "delta"
        && item["unchanged"] != true
        && item["status"] == "synced"));
    assert_eq!(handler.package_provider.0.load(Ordering::SeqCst), 4);
    let result = handler
        .apply_sync(complete(12, vec![a, b, d]))
        .await
        .unwrap();
    assert!(result["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["unchanged"] == true));
}

#[tokio::test]
async fn identity_version_and_component_changes_cannot_reuse_the_old_installation() {
    for (field, value) in [
        ("installed_plugin_id", json!(99)),
        ("cloud_plugin_id", json!(42)),
        ("version", json!("2.0.0")),
        ("component_states", json!({"skill:demo": false})),
    ] {
        let (_root, handler) = shared_fixture(true);
        let mut desired = desired("alpha", 1);
        handler
            .apply_sync(complete(10, vec![desired.clone()]))
            .await
            .unwrap();
        desired[field] = value;
        let result = handler
            .apply_sync(complete(11, vec![desired.clone()]))
            .await
            .unwrap();
        assert_eq!(result["success"], true, "{field}: {result}");
        assert_ne!(result["plugins"][0]["unchanged"], true, "{field}");
        if field == "component_states" {
            let config = handler
                .store
                .codex_plugins_dir
                .parent()
                .unwrap()
                .join("config.toml");
            assert!(fs::read_to_string(config)
                .unwrap()
                .contains("enabled = false"));
        }
        let result = handler
            .apply_sync(complete(12, vec![desired]))
            .await
            .unwrap();
        assert_eq!(result["plugins"][0]["unchanged"], true, "{field}: {result}");
    }
}

#[tokio::test]
async fn matching_runtime_does_not_hide_a_corrupted_shared_package() {
    let (root, handler) = shared_fixture(true);
    let desired = desired("alpha", 1);
    handler
        .apply_sync(complete(10, vec![desired.clone()]))
        .await
        .unwrap();
    let manifest = handler.store.manifest.load().unwrap();
    let package = PathBuf::from(
        manifest["plugins"]["alpha@wework"]["store_path"]
            .as_str()
            .unwrap(),
    );
    fs::write(package.join("payload.txt"), "tampered package").unwrap();
    let result = handler
        .apply_sync(complete(11, vec![desired]))
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["plugins"][0]["unchanged"], true);
    assert_eq!(
        fs::read(package.join("payload.txt")).unwrap(),
        b"valid plugin contents"
    );
    assert_eq!(handler.package_provider.0.load(Ordering::SeqCst), 2);
    let history = root
        .path()
        .join("workbench/shared/recovery/plugins")
        .join(package.file_name().unwrap());
    let backups = fs::read_dir(history)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read(backups[0].path().join("package/payload.txt")).unwrap(),
        b"tampered package"
    );
}

#[tokio::test]
async fn a_previous_ownership_witness_cannot_hide_an_incorrect_current_runtime_path() {
    let (_root, handler) = shared_fixture(true);
    let desired = desired("alpha", 1);
    handler
        .apply_sync(complete(10, vec![desired.clone()]))
        .await
        .unwrap();
    let mut manifest = handler.store.manifest.load().unwrap();
    let original = manifest["plugins"]["alpha@wework"].clone();
    manifest["plugins"]["alpha@wework"]["previous"] = original;
    manifest["plugins"]["alpha@wework"]["runtime"]["codex_link"] =
        json!("/incorrect/current/runtime");
    let spec = PluginSyncSpec::from_value(&desired).unwrap();
    let package = Path::new(
        manifest["plugins"]["alpha@wework"]["store_path"]
            .as_str()
            .unwrap(),
    );
    let reused = handler
        .store
        .unchanged_plugin_runtime_paths(&spec, package)
        .unwrap();
    assert!(!handler
        .store
        .plugin_metadata_matches(&spec, &manifest, package, &reused)
        .unwrap());
}

#[tokio::test]
async fn runtime_corruption_and_native_configuration_drift_are_not_hidden_by_matching_versions() {
    for damage in ["payload", "missing", "metadata", "skill-state", "hook-mode"] {
        let (_root, handler) = shared_fixture(true);
        let mut desired = desired("alpha", 1);
        desired["component_states"] = json!({"skill:demo": false});
        handler
            .apply_sync(complete(10, vec![desired.clone()]))
            .await
            .unwrap();
        let spec = PluginSyncSpec::from_value(&desired).unwrap();
        let runtime = handler.store.plugin_codex_link(&spec);
        let config = handler
            .store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        match damage {
            "payload" => fs::write(runtime.join("payload.txt"), "tampered").unwrap(),
            "missing" => fs::remove_file(runtime.join("payload.txt")).unwrap(),
            "metadata" => fs::remove_file(
                handler
                    .store
                    .codex_marketplace_dir("wework")
                    .join(".agents/plugins/marketplace.json"),
            )
            .unwrap(),
            "skill-state" => {
                let content = fs::read_to_string(&config).unwrap();
                fs::write(
                    &config,
                    content.replace("enabled = false", "enabled = true"),
                )
                .unwrap();
            }
            "hook-mode" => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        runtime.join("hooks/start.sh"),
                        fs::Permissions::from_mode(0o644),
                    )
                    .unwrap();
                }
                #[cfg(not(unix))]
                {
                    fs::remove_file(runtime.join("hooks/start.sh")).unwrap();
                }
            }
            _ => unreachable!(),
        }
        let result = handler
            .apply_sync(complete(11, vec![desired.clone()]))
            .await
            .unwrap();
        assert_eq!(result["success"], true, "{damage}: {result}");
        assert_ne!(result["plugins"][0]["unchanged"], true, "{damage}");
        assert_eq!(
            fs::read_to_string(runtime.join("payload.txt")).unwrap(),
            "valid plugin contents"
        );
        let result = handler
            .apply_sync(complete(12, vec![desired]))
            .await
            .unwrap();
        assert_eq!(
            result["plugins"][0]["unchanged"], true,
            "{damage}: {result}"
        );
    }
}

#[tokio::test]
async fn native_metadata_probe_waits_for_publication_before_comparing() {
    let (_root, handler) = shared_fixture(true);
    let desired = desired("alpha", 1);
    let installed = handler
        .apply_sync(complete(10, vec![desired.clone()]))
        .await
        .unwrap();
    assert_eq!(installed["success"], true);
    let handler = std::sync::Arc::new(handler);
    let snapshot = handler.store.manifest.load().unwrap();
    let spec = PluginSyncSpec::from_value(&desired).unwrap();
    let lease = std::sync::Arc::new(plugin_preparation::PreparationLease {
        _lane: None,
        _slot: handler
            .plugin_preparation
            .slots
            .clone()
            .acquire_owned()
            .await
            .unwrap(),
    });
    let publication = handler.sync_lock.lock().await;
    let worker = handler.clone();
    let mut preparing = tokio::spawn(async move {
        worker
            .prepare_plugin(&spec, &snapshot, lease, Some(worker.sync_lock.clone()))
            .await
    });
    // An active writer must exclude the complete metadata read/compare transaction.
    let while_writing =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut preparing).await;
    assert!(
        while_writing.is_err(),
        "Metadata was inspected during publication"
    );
    drop(publication);
    let prepared = preparing.await.unwrap().unwrap();
    assert!(prepared.unchanged);
    assert_eq!(handler.package_provider.0.load(Ordering::SeqCst), 1);
}
