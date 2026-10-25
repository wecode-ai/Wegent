// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use super::tests::{archive, payload, store, Packages};
use super::*;

#[tokio::test]
async fn new_install_id_can_replace_its_retained_marketplace_source_from_another_version() {
    for codex_only in [false, true] {
        for (old_version, new_version) in [("1.0", "2.0"), ("2.0", "1.0")] {
            let temp = tempfile::tempdir().unwrap();
            let store = store(temp.path(), codex_only);
            let handler = CapabilitySyncHandler::with_package_provider(
                "",
                store.clone(),
                Packages(archive("demo")),
            );
            let mut request = payload("demo");
            request["plugins"][0]["version"] = json!(old_version);
            let installed = handler.apply_sync(request.clone()).await.unwrap();
            assert_eq!(installed["success"], true, "{installed}");
            let old = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
            let removed = handler
                .apply_sync(json!({"scope":"plugins","plugins":[]}))
                .await
                .unwrap();
            assert_eq!(removed["success"], true, "{removed}");
            assert!(store.manifest.load().unwrap()["plugins"]
                .as_object()
                .unwrap()
                .is_empty());
            let restarted = CapabilitySyncHandler::with_package_provider(
                "",
                store.clone(),
                Packages(archive("demo")),
            );
            request["plugins"][0]["version"] = json!(new_version);
            request["plugins"][0]["installed_plugin_id"] = json!(69);

            let reinstalled = restarted.apply_sync(request).await.unwrap();

            assert_eq!(reinstalled["success"], true, "{reinstalled}");
            let manifest = store.manifest.load().unwrap();
            let entry = &manifest["plugins"]["demo@wegent"];
            assert_eq!(entry["installed_plugin_id"], 69);
            assert_eq!(entry["version"], new_version);
            let spec = checked_spec("demo@wegent", entry).unwrap();
            for (runtime, field) in store.plugin_runtime_targets(&spec) {
                let claude = field == "claude_link";
                let marketplace = if claude {
                    store.claude_marketplace_dir("wegent")
                } else {
                    store.codex_marketplace_dir("wegent")
                };
                let source = marketplace
                    .join("plugins")
                    .join(store.marketplace_plugin_name(&spec, claude));
                assert_eq!(fs::read_link(source).unwrap(), runtime);
                assert!(runtime.join(".codex-plugin/plugin.json").is_file());
                let old_runtime = old["runtime"][field].as_str().unwrap();
                assert_eq!(
                    manifest["plugin_runtime_owners"][old_runtime],
                    "demo@wegent"
                );
                assert!(Path::new(old_runtime).is_dir());
            }
        }
    }
}

#[tokio::test]
async fn reinstall_preserves_unowned_or_differently_owned_marketplace_sources() {
    for foreign in [
        "unowned-cache",
        "other-owner",
        "outside-root",
        "other-plugin",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path(), true);
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
        );
        let installed = handler.apply_sync(payload("demo")).await.unwrap();
        assert_eq!(installed["success"], true, "{installed}");
        let removed = handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap();
        assert_eq!(removed["success"], true, "{removed}");
        let target = match foreign {
            "outside-root" => temp.path().join("personal/plugins/cache/wegent/demo/0.5"),
            "other-plugin" => store.codex_plugins_dir.join("cache/wegent/another/0.5"),
            _ => store.codex_plugins_dir.join("cache/wegent/demo/0.5"),
        };
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("source.txt"), "keep unrelated source").unwrap();
        let market = store.codex_marketplace_dir("wegent").join("plugins/demo");
        remove_existing_path(&market).unwrap();
        std::os::unix::fs::symlink(&target, &market).unwrap();
        let mut manifest = store.manifest.load().unwrap();
        let expected_plugins = manifest["plugins"].clone();
        if foreign != "unowned-cache" {
            manifest["plugin_runtime_owners"][target.to_string_lossy().as_ref()] =
                json!(if foreign == "other-owner" {
                    "another@wegent"
                } else {
                    "demo@wegent"
                });
            store.manifest.save(manifest).unwrap();
        }
        let mut request = payload("demo");
        request["plugins"][0]["version"] = json!("2.0");
        request["plugins"][0]["installed_plugin_id"] = json!(69);

        let reinstalled = handler.apply_sync(request).await.unwrap();

        assert_eq!(reinstalled["success"], false, "{foreign}: {reinstalled}");
        assert!(reinstalled
            .to_string()
            .contains("Plugin marketplace entry is occupied by an unrelated source"));
        assert_eq!(fs::read_link(&market).unwrap(), target);
        assert_eq!(
            fs::read_to_string(target.join("source.txt")).unwrap(),
            "keep unrelated source"
        );
        assert_eq!(store.manifest.load().unwrap()["plugins"], expected_plugins);
    }
}
