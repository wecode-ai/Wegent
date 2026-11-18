// SPDX-License-Identifier: Apache-2.0

use super::super::tests::{payload, store, Packages};
use super::*;
use std::io::{Cursor, Write};

#[path = "marketplace_source_recovery_tests.rs"]
mod recovery_tests;

fn package(name: &str, version: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, body) in [
        (
            ".codex-plugin/plugin.json",
            format!(r#"{{"name":"{name}","version":"{version}","skills":"./skills/"}}"#),
        ),
        (
            "skills/demo/SKILL.md",
            format!("---\nname: demo\ndescription: Capability {version}\n---\n{name} {version}\n"),
        ),
    ] {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

async fn sync(store: &GlobalCapabilityStore, version: &str, id: i64) -> Value {
    let bytes = package("demo", version);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(bytes.clone()),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["version"] = json!(version);
    request["plugins"][0]["checksum"] = json!(sha256_digest(&bytes));
    request["plugins"][0]["installed_plugin_id"] = json!(id);
    handler.apply_sync(request).await.unwrap()
}

async fn uninstall(store: &GlobalCapabilityStore) {
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(Vec::new()),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler
        .apply_sync(json!({"scope":"plugins", "plugins":[]}))
        .await
        .unwrap();
    assert_eq!(result["success"], true, "{result}");
    assert!(store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
}

struct Fixture {
    _root: tempfile::TempDir,
    store: GlobalCapabilityStore,
    sources: Vec<PathBuf>,
    runtime: PathBuf,
}

impl Fixture {
    async fn new(codex_only: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path(), codex_only);
        // All three historical versions exist, including the requested target cache.
        assert_eq!(sync(&store, "0.8.1", 39).await["success"], true);
        assert_eq!(sync(&store, "0.9.12", 40).await["success"], true);
        assert_eq!(sync(&store, "0.1.6", 41).await["success"], true);
        let manifest = store.manifest.load().unwrap();
        let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        let mut sources = Vec::new();
        for (runtime, field) in store.plugin_runtime_targets(&spec) {
            let claude = field == "claude_link";
            let market = if claude {
                store.claude_marketplace_dir("wegent")
            } else {
                store.codex_marketplace_dir("wegent")
            };
            let source = market
                .join("plugins")
                .join(store.marketplace_plugin_name(&spec, claude));
            remove_existing_path(&source).unwrap();
            copy_dir_recursive(&runtime, &source).unwrap();
            assert!(!source.is_symlink());
            sources.push(source);
        }
        let runtime = store.plugin_codex_link(&spec);
        Self {
            _root: root,
            store,
            sources,
            runtime,
        }
    }

    fn assert_version(&self, version: &str) {
        for source in &self.sources {
            let manifest: Value =
                serde_json::from_slice(&fs::read(source.join(CODEX_PLUGIN_MANIFEST_PATH)).unwrap())
                    .unwrap();
            assert_eq!(manifest["version"], version);
            assert!(fs::read_to_string(source.join("skills/demo/SKILL.md"))
                .unwrap()
                .contains(version));
        }
    }
}

#[tokio::test]
async fn copied_marketplace_sources_reinstall_from_verified_receipts_after_restart() {
    for codex_only in [true, false] {
        let fixture = Fixture::new(codex_only).await;
        uninstall(&fixture.store).await;
        let removed = fixture.store.manifest.load().unwrap();
        assert_eq!(removed[RECEIPTS]["demo@wegent"]["version"], "0.1.6");
        let restarted = store(fixture._root.path(), codex_only);
        let report = restarted.reconcile_managed_plugin_runtimes().unwrap();
        assert!(
            report.restored.is_empty(),
            "A receipt must not reinstall a removed plugin"
        );
        let result = sync(&restarted, "0.9.12", 69).await;
        assert_eq!(result["success"], true, "{result}");
        fixture.assert_version("0.9.12");
        let installed = fixture.store.manifest.load().unwrap();
        assert_eq!(
            installed["plugins"]["demo@wegent"]["installed_plugin_id"],
            69
        );
        assert_eq!(installed[RECEIPTS]["demo@wegent"]["version"], "0.9.12");
        let runtime = installed["plugins"]["demo@wegent"]["runtime"]["codex_link"]
            .as_str()
            .unwrap();
        let runtime_manifest: Value = serde_json::from_slice(
            &fs::read(Path::new(runtime).join(CODEX_PLUGIN_MANIFEST_PATH)).unwrap(),
        )
        .unwrap();
        assert_eq!(runtime_manifest["version"], "0.9.12");
        assert!(
            fixture.runtime.is_dir(),
            "Old runtime caches remain available"
        );
    }
}

#[tokio::test]
async fn copied_marketplace_sources_accept_a_new_install_id_with_verified_active_state() {
    let fixture = Fixture::new(true).await;
    // Existing installations from older clients do not have the new receipt.
    let mut manifest = fixture.store.manifest.load().unwrap();
    manifest.as_object_mut().unwrap().remove(RECEIPTS);
    fixture.store.manifest.save(manifest).unwrap();
    let result = sync(&fixture.store, "0.9.12", 69).await;
    assert_eq!(result["success"], true, "{result}");
    fixture.assert_version("0.9.12");
}

#[tokio::test]
async fn copied_marketplace_sources_preserve_the_existing_same_install_update() {
    let fixture = Fixture::new(true).await;
    let mut manifest = fixture.store.manifest.load().unwrap();
    manifest[RECEIPTS]["demo@wegent"]["checksum"] = json!("invalid-retained-checksum");
    fixture.store.manifest.save(manifest).unwrap();
    let result = sync(&fixture.store, "0.9.12", 41).await;
    assert_eq!(result["success"], true, "{result}");
    fixture.assert_version("0.9.12");
}

#[tokio::test]
async fn copied_marketplace_sources_preserve_changed_foreign_or_unverifiable_data() {
    for alteration in [
        "changed-source",
        "changed-both",
        "foreign-owner",
        "missing-owner",
        "no-receipt",
        "missing-install-id",
        "missing-checksum",
        "unmanaged",
        "outside-runtime",
        "wrong-key",
        "wrong-package",
    ] {
        let fixture = Fixture::new(true).await;
        uninstall(&fixture.store).await;
        let source = &fixture.sources[0];
        let mut manifest = fixture.store.manifest.load().unwrap();
        match alteration {
            "changed-source" | "changed-both" => {
                fs::write(source.join("skills/demo/SKILL.md"), "user changes").unwrap();
                if alteration == "changed-both" {
                    fs::write(fixture.runtime.join("skills/demo/SKILL.md"), "user changes")
                        .unwrap();
                }
            }
            "foreign-owner" => {
                manifest["plugin_runtime_owners"][fixture.runtime.to_string_lossy().as_ref()] =
                    json!("another@wegent")
            }
            "missing-owner" => {
                manifest["plugin_runtime_owners"]
                    .as_object_mut()
                    .unwrap()
                    .clear();
            }
            "no-receipt" => {
                manifest.as_object_mut().unwrap().remove(RECEIPTS);
            }
            "missing-install-id" => {
                manifest[RECEIPTS]["demo@wegent"]["installed_plugin_id"] = Value::Null;
            }
            "missing-checksum" => {
                manifest[RECEIPTS]["demo@wegent"]["checksum"] = Value::Null;
            }
            "unmanaged" => manifest[RECEIPTS]["demo@wegent"]["managed"] = json!(false),
            "outside-runtime" => {
                manifest[RECEIPTS]["demo@wegent"]["runtime"]["codex_link"] =
                    json!(fixture._root.path().join("foreign/0.1.6"))
            }
            "wrong-key" => manifest[RECEIPTS]["demo@wegent"]["name"] = json!("another"),
            "wrong-package" => {
                let bytes = package("another", "0.1.6");
                let package = crate::services::workbench::publish_plugin_archive(
                    &fixture._root.path().join("workbench"),
                    &bytes,
                    None,
                )
                .unwrap();
                remove_existing_path(source).unwrap();
                copy_dir_recursive(&package.path, source).unwrap();
                ensure_dual_plugin_manifests(source).unwrap();
                manifest[RECEIPTS]["demo@wegent"]["checksum"] = json!(package.archive_hash);
            }
            _ => unreachable!(),
        }
        fixture.store.manifest.save(manifest).unwrap();
        let before = tree_fingerprint(source).unwrap();
        let result = sync(&fixture.store, "0.9.12", 69).await;
        assert_eq!(result["success"], false, "{alteration}: {result}");
        assert_eq!(tree_fingerprint(source).unwrap(), before, "{alteration}");
        assert!(fixture.store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn copied_marketplace_sources_roll_back_a_failed_configuration_commit() {
    for retained_target in [false, true] {
        let fixture = Fixture::new(true).await;
        uninstall(&fixture.store).await;
        let original = fixture.store.manifest.load().unwrap();
        let target = fixture
            .store
            .codex_plugins_dir
            .join("cache/wegent/demo/0.9.12");
        if !retained_target {
            remove_existing_path(&target).unwrap();
        }
        let before = retained_target.then(|| tree_fingerprint(&target).unwrap());
        let config = fixture
            .store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        fs::write(&config, "invalid [ config").unwrap();
        let result = sync(&fixture.store, "0.9.12", 69).await;
        assert_eq!(result["success"], false, "{result}");
        fixture.assert_version("0.1.6");
        assert!(
            !fixture.sources[0].is_symlink(),
            "Restore the original directory copy"
        );
        let after = fixture.store.manifest.load().unwrap();
        assert_eq!(after[RECEIPTS], original[RECEIPTS]);
        assert!(after["plugins"].as_object().unwrap().is_empty());
        assert_eq!(target.exists(), retained_target);
        if let Some(before) = before {
            assert_eq!(tree_fingerprint(&target).unwrap(), before);
        }
    }
}
