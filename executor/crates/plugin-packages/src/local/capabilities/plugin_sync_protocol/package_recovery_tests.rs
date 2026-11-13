// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn shared_fixture() -> (tempfile::TempDir, CapabilitySyncHandler<Provider>) {
    let root = tempfile::tempdir().unwrap();
    let mut store = GlobalCapabilityStore::new(
        root.path().join("capabilities/manifest-v2.json"),
        root.path().join("claude/skills"),
    )
    .with_plugins_dir(root.path().join("claude/plugins"))
    .with_codex_skills_dir(root.path().join("codex/skills"))
    .with_codex_plugins_dir(root.path().join("codex/plugins"))
    .with_workbench_root(root.path().join("workbench"));
    store.codex_only_plugins = false;
    let handler = CapabilitySyncHandler::with_package_provider(
        "test",
        store,
        Provider::default(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    (root, handler)
}

fn recovery_request(generation: u64, ordered: bool, marketplace: &str) -> Value {
    let mut desired = plugin("alpha", 1);
    desired["marketplace"] = json!(marketplace);
    if ordered {
        complete(generation, vec![desired])
    } else {
        json!({"scope":"plugins", "plugins":[desired]})
    }
}

fn marketplace_sources(store: &GlobalCapabilityStore, spec: &PluginSyncSpec) -> Vec<PathBuf> {
    store
        .plugin_runtime_targets(spec)
        .into_iter()
        .map(|(_, field)| {
            let claude = field == "claude_link";
            let market = if claude {
                store.claude_marketplace_dir(&spec.marketplace)
            } else {
                store.codex_marketplace_dir(&spec.marketplace)
            };
            market
                .join("plugins")
                .join(store.marketplace_plugin_name(spec, claude))
        })
        .collect()
}

fn copy_marketplace_sources(store: &GlobalCapabilityStore, spec: &PluginSyncSpec) -> Vec<PathBuf> {
    let sources = marketplace_sources(store, spec);
    for ((runtime, _), source) in store.plugin_runtime_targets(spec).into_iter().zip(&sources) {
        remove_existing_path(source).unwrap();
        copy_dir_recursive(&runtime, source).unwrap();
        assert!(!source.is_symlink());
    }
    sources
}

#[tokio::test]
async fn recovery_covers_both_protocols_runtime_modes_and_marketplace_entry_forms() {
    for ordered in [false, true] {
        for codex_only in [false, true] {
            for copied in [false, true] {
                for corrupt in [false, true] {
                    for marketplace in ["wegent", "wework", PERSONAL_SHARED_PLUGIN_MARKETPLACE] {
                        assert_recovery_case(ordered, codex_only, copied, corrupt, marketplace)
                            .await;
                    }
                }
            }
        }
    }
}

async fn assert_recovery_case(
    ordered: bool,
    codex_only: bool,
    copied: bool,
    corrupt: bool,
    marketplace: &str,
) {
    let (_root, mut handler) = shared_fixture();
    handler.store.codex_only_plugins = codex_only;
    let request = recovery_request(1, ordered, marketplace);
    let spec = PluginSyncSpec::from_value(&request["plugins"][0]).unwrap();
    assert_eq!(handler.apply_sync(request).await.unwrap()["success"], true);
    let before = handler.store.manifest.load().unwrap();
    let entry = &before["plugins"][&spec.key];
    let package = PathBuf::from(entry["store_path"].as_str().unwrap());
    if copied {
        copy_marketplace_sources(&handler.store, &spec);
    }
    if corrupt {
        fs::write(package.join("payload.txt"), "corrupt cache").unwrap();
    }
    let result = handler
        .apply_sync(recovery_request(2, ordered, marketplace))
        .await
        .unwrap();
    assert_eq!(
        result["success"], true,
        "marketplace={marketplace} ordered={ordered} codex_only={codex_only} copied={copied} corrupt={corrupt}: {result}"
    );
    let after = handler.store.manifest.load().unwrap();
    for field in ["version", "checksum", "store_path", "runtime"] {
        assert_eq!(after["plugins"][&spec.key][field], entry[field]);
    }
    for source in marketplace_sources(&handler.store, &spec)
        .into_iter()
        .chain([package])
    {
        assert_eq!(
            fs::read(source.join("payload.txt")).unwrap(),
            b"valid plugin contents"
        );
    }
    assert_eq!(
        handler.package_provider.calls.load(Ordering::SeqCst),
        if corrupt { 2 } else { 1 }
    );
}

#[tokio::test]
async fn recovery_preserves_an_unrelated_directory_copy_and_the_current_runtime() {
    for ordered in [false, true] {
        let (_root, handler) = shared_fixture();
        let request = recovery_request(1, ordered, "wework");
        let spec = PluginSyncSpec::from_value(&request["plugins"][0]).unwrap();
        assert_eq!(handler.apply_sync(request).await.unwrap()["success"], true);
        let before = handler.store.manifest.load().unwrap();
        let package = PathBuf::from(before["plugins"][&spec.key]["store_path"].as_str().unwrap());
        let sources = copy_marketplace_sources(&handler.store, &spec);
        fs::write(
            sources[0].join("payload.txt"),
            "unrelated personal contents",
        )
        .unwrap();
        fs::write(package.join("payload.txt"), "corrupt cache").unwrap();
        let result = handler
            .apply_sync(recovery_request(2, ordered, "wework"))
            .await
            .unwrap();
        assert_eq!(result["success"], false, "{result}");
        assert_eq!(
            result["plugins"][0]["error_code"],
            "PLUGIN_RUNTIME_METADATA_FAILED"
        );
        assert_eq!(
            fs::read(sources[0].join("payload.txt")).unwrap(),
            b"unrelated personal contents"
        );
        assert_eq!(
            handler.store.manifest.load().unwrap()["plugins"],
            before["plugins"]
        );
        for (runtime, _) in handler.store.plugin_runtime_targets(&spec) {
            assert_eq!(
                fs::read(runtime.join("payload.txt")).unwrap(),
                b"valid plugin contents"
            );
        }
    }
}

#[tokio::test]
async fn verified_reinstall_repairs_shared_package_without_upgrading_or_touching_other_plugins() {
    let (root, handler) = shared_fixture();
    assert_eq!(
        handler
            .apply_sync(complete(1, vec![plugin("alpha", 1), plugin("beta", 2)]))
            .await
            .unwrap()["success"],
        true
    );
    let before = handler.store.manifest.load().unwrap();
    let alpha = &before["plugins"]["alpha@wework"];
    let package = PathBuf::from(alpha["store_path"].as_str().unwrap());
    let runtime = PathBuf::from(alpha["runtime"]["codex_link"].as_str().unwrap());
    fs::write(
        package.join("unexpected-local-file.txt"),
        "retained diagnosis evidence",
    )
    .unwrap();
    let result = handler
        .apply_sync(delta(2, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    assert_eq!(result["plugins"][0]["status"], "synced");
    assert_eq!(result["plugins"][0]["version"], "1.0.0");
    assert_eq!(
        result["plugins"][0]["checksum"],
        sha256_digest(&super::package("alpha"))
    );
    let after = handler.store.manifest.load().unwrap();
    assert_eq!(
        after["plugins"]["beta@wework"],
        before["plugins"]["beta@wework"]
    );
    assert_eq!(
        after["plugins"]["alpha@wework"]["store_path"],
        alpha["store_path"]
    );
    assert_eq!(
        after["plugins"]["alpha@wework"]["checksum"],
        alpha["checksum"]
    );
    assert!(!package.join("unexpected-local-file.txt").exists());
    assert_eq!(
        fs::read(runtime.join("payload.txt")).unwrap(),
        b"valid plugin contents"
    );
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
        fs::read_to_string(backups[0].path().join("package/unexpected-local-file.txt")).unwrap(),
        "retained diagnosis evidence"
    );
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        handler
            .apply_sync(delta(3, vec![plugin("alpha", 1)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn failed_download_preserves_corrupt_package_and_usable_runtime() {
    let (_root, handler) = shared_fixture();
    handler
        .apply_sync(delta(1, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    let before = handler.store.manifest.load().unwrap();
    let alpha = &before["plugins"]["alpha@wework"];
    let source = PathBuf::from(alpha["store_path"].as_str().unwrap());
    let runtime = PathBuf::from(alpha["runtime"]["codex_link"].as_str().unwrap());
    fs::write(source.join("payload.txt"), "damaged cache").unwrap();
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    let result = handler
        .apply_sync(delta(2, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    assert_eq!(result["plugins"][0]["status"], "failed");
    assert_eq!(result["plugins"][0]["error_code"], "PLUGIN_DOWNLOAD_FAILED");
    assert_eq!(
        fs::read(source.join("payload.txt")).unwrap(),
        b"damaged cache"
    );
    assert_eq!(
        fs::read(runtime.join("payload.txt")).unwrap(),
        b"valid plugin contents"
    );
    assert_eq!(
        handler.store.manifest.load().unwrap()["plugins"],
        before["plugins"]
    );
}
