// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn merge_plugin_payload(name: &str) -> Value {
    let mut request = payload(name);
    request.as_object_mut().unwrap().remove("scope");
    request["mode"] = json!("merge");
    request
}

#[tokio::test]
async fn skill_and_mcp_sync_do_not_recover_unrelated_migrated_plugins() {
    for request in [
        json!({"skills":[{"name":"standalone","skill_id":55}]}),
        json!({"mcps":[{"name":"standalone","url":"https://example.test/mcp"}]}),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        installed(&old, true).await;
        fs::rename(&old, &new).unwrap();
        let store = store(&new, true);
        fs::remove_dir_all(new.join("workbench/shared")).unwrap();
        let target = new.join("codex/plugins/cache/wegent/demo/1.0");
        fs::remove_dir_all(&target).unwrap();
        let before = store.manifest.load().unwrap();
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
        );

        let result = handler.apply_sync(request.clone()).await.unwrap();

        assert_eq!(result["success"], true, "{result}");
        let after = store.manifest.load().unwrap();
        assert_eq!(after["plugins"], before["plugins"]);
        assert_eq!(
            after["plugin_runtime_owners"],
            before["plugin_runtime_owners"]
        );
        if request.get("skills").is_some() {
            assert_eq!(result["skills"][0]["status"], "synced");
            assert!(after["skills"]["standalone"]["managed"].as_bool().unwrap());
        } else {
            assert_eq!(after["mcps"]["standalone"]["managed"], true);
        }
        assert!(!target.exists());
        assert!(!old.exists());
    }
}

#[tokio::test]
async fn single_plugin_sync_does_not_recover_an_unrelated_migrated_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    installed(&old, true).await;
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    fs::remove_dir_all(new.join("workbench/shared")).unwrap();
    let unrelated = new.join("codex/plugins/cache/wegent/demo/1.0");
    fs::remove_dir_all(&unrelated).unwrap();
    let before = store.manifest.load().unwrap();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("another")),
    );

    let result = handler
        .apply_sync(merge_plugin_payload("another"))
        .await
        .unwrap();

    assert_eq!(result["success"], true, "{result}");
    let after = store.manifest.load().unwrap();
    assert_eq!(
        after["plugins"]["demo@wegent"],
        before["plugins"]["demo@wegent"]
    );
    assert!(new.join("codex/plugins/cache/wegent/another/1.0").is_dir());
    assert!(!unrelated.exists());
    assert!(!old.exists());
}

#[tokio::test]
async fn requested_plugin_retry_uses_fresh_archive_after_startup_package_recovery_failed() {
    for codex_only in [false, true] {
        for version in ["1.0", "2.0"] {
            let temp = tempfile::tempdir().unwrap();
            let old = temp.path().join("old");
            let new = temp.path().join("new");
            let original = installed(&old, false).await;
            let mut value = original.manifest.load().unwrap();
            value
                .as_object_mut()
                .unwrap()
                .remove("plugin_runtime_owners");
            value["plugins"]["demo@wegent"]
                .as_object_mut()
                .unwrap()
                .remove("checksum");
            original.manifest.save(value).unwrap();
            fs::remove_dir_all(old.join("workbench/shared")).unwrap();
            fs::rename(&old, &new).unwrap();
            let store = store(&new, codex_only);
            let report = store.reconcile_managed_plugin_runtimes().unwrap();
            assert!(report.failed.contains_key("demo@wegent"));
            let mut request = merge_plugin_payload("demo");
            request["plugins"][0]["version"] = json!(version);
            let handler = CapabilitySyncHandler::with_package_provider(
                "",
                store.clone(),
                Packages(archive("demo")),
            );

            let result = handler.apply_sync(request).await.unwrap();

            assert_eq!(result["success"], true, "{result}");
            let value = store.manifest.load().unwrap();
            let entry = &value["plugins"]["demo@wegent"];
            assert!(entry.get("runtime_recovery_error").is_none());
            assert_eq!(entry["version"], version);
            assert!(Path::new(entry["store_path"].as_str().unwrap())
                .starts_with(new.join("workbench/shared/plugins")));
            let target = new.join("codex/plugins/cache/wegent/demo").join(version);
            assert_eq!(
                Path::new(entry["runtime"]["codex_link"].as_str().unwrap()),
                target
            );
            assert_eq!(
                fs::read_to_string(target.join("skills/demo/SKILL.md")).unwrap(),
                "plugin capability"
            );
            if codex_only {
                assert!(entry["runtime"].get("claude_link").is_none());
            } else {
                assert!(Path::new(entry["runtime"]["claude_link"].as_str().unwrap())
                    .starts_with(new.join("claude/plugins")));
            }
            assert!(!old.exists());
        }
    }
}

#[tokio::test]
async fn migrated_same_version_update_authenticates_existing_cache_with_previous_package() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let before = original.manifest.load().unwrap();
    let previous_checksum = before["plugins"]["demo@wegent"]["checksum"].clone();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive_payload("demo", "updated same version")),
    );

    let result = handler
        .apply_sync(merge_plugin_payload("demo"))
        .await
        .unwrap();

    assert_eq!(result["success"], true, "{result}");
    let manifest = store.manifest.load().unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    assert_eq!(entry["version"], "1.0");
    assert_ne!(entry["checksum"], previous_checksum);
    assert_eq!(
        fs::read_to_string(new.join("codex/plugins/cache/wegent/demo/1.0/skills/demo/SKILL.md"))
            .unwrap(),
        "updated same version"
    );
    assert!(!old.exists());
}

#[tokio::test]
async fn requested_plugin_sync_preserves_unrelated_targets_and_conflicting_owners() {
    for conflicting_owner in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        installed(&old, true).await;
        fs::rename(&old, &new).unwrap();
        let store = store(&new, true);
        let target = new.join("codex/plugins/cache/wegent/demo/1.0");
        if conflicting_owner {
            let mut manifest = store.manifest.load().unwrap();
            manifest["plugin_runtime_owners"][target.to_string_lossy().as_ref()] =
                json!("another@wegent");
            store.manifest.save(manifest).unwrap();
        } else {
            fs::write(target.join("personal.txt"), "keep").unwrap();
        }
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
        );

        let result = handler
            .apply_sync(merge_plugin_payload("demo"))
            .await
            .unwrap();

        assert_eq!(result["success"], false, "{result}");
        if conflicting_owner {
            let manifest = store.manifest.load().unwrap();
            assert_eq!(
                manifest["plugin_runtime_owners"][target.to_string_lossy().as_ref()],
                "another@wegent"
            );
        } else {
            assert_eq!(
                fs::read_to_string(target.join("personal.txt")).unwrap(),
                "keep"
            );
        }
        assert!(!old.exists());
    }
}
