// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use super::*;
use crate::local::capabilities::runtime_recovery::tests::{archive, payload, store, Packages};

// Boundary fixtures exercise legacy ownership independently of a modern install.
// The desktop regression obtains the same state from immutable historical binaries.
fn legacy_install(root: &Path) -> (GlobalCapabilityStore, PathBuf, Value) {
    let store = store(root, true);
    let package = root.join("executor/capabilities/store/plugins/41-wegent-demo-1.0");
    extract_plugin_zip(&archive("demo"), &package).unwrap();
    let runtime = root.join("codex/plugins/cache/wegent/demo/1.0");
    copy_dir_atomic(&package, &runtime).unwrap();
    let market = store.codex_marketplace_dir("wegent").join("plugins/demo");
    fs::create_dir_all(market.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&package, &market).unwrap();
    let entry = json!({
        "managed":true,"name":"demo","key":"demo@wegent","marketplace":"wegent",
        "installed_plugin_id":41,"version":"1.0","enabled":false,
        "store_path":package,"runtime":{"codex_link":runtime},
        "component_states":{"skill:demo":false}
    });
    let legacy = json!({"version":1,"plugins":{"demo@wegent":entry},"skills":{},"mcps":{}});
    write_json(
        &store.manifest.path.with_file_name("manifest.json"),
        &legacy,
    )
    .unwrap();
    (store, market, entry)
}

#[tokio::test]
async fn legacy_sources_survive_uninstall_and_allow_explicit_reinstall() {
    for frozen_record in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (store, market, old) = legacy_install(temp.path());
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let imported = store.manifest.load().unwrap();
        assert_eq!(imported["version"], 2);
        if !frozen_record {
            fs::remove_file(store.manifest.path.with_file_name("manifest.json")).unwrap();
        }
        let removed = handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap();
        assert_eq!(removed["success"], true, "{removed}");
        assert!(store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_link(&market).unwrap(),
            Path::new(old["store_path"].as_str().unwrap())
        );
        assert!(store
            .reconcile_managed_plugin_runtimes()
            .unwrap()
            .restored
            .is_empty());
        let mut request = payload("demo");
        request["plugins"][0]["installed_plugin_id"] = json!(69);
        let result = handler.apply_sync(request.clone()).await.unwrap();
        assert_eq!(result["success"], true, "{result}");
        let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
        assert_eq!(entry["installed_plugin_id"], 69);
        assert_eq!(
            fs::read_link(&market).unwrap(),
            Path::new(entry["runtime"]["codex_link"].as_str().unwrap())
        );
        assert!(Path::new(old["store_path"].as_str().unwrap()).is_dir());
        assert_eq!(handler.apply_sync(request).await.unwrap()["success"], true);
    }
}

#[tokio::test]
async fn frozen_v1_evidence_recovers_an_already_uninstalled_legacy_source() {
    let temp = tempfile::tempdir().unwrap();
    let (store, market, old) = legacy_install(temp.path());
    let mut manifest = store.manifest.load().unwrap();
    shared_packages::remember_plugin_runtime_owner(&mut manifest, "demo@wegent", &old);
    manifest["plugins"] = json!({});
    store.manifest.save(manifest).unwrap();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    assert_ne!(
        fs::read_link(market).unwrap(),
        PathBuf::from(old["store_path"].as_str().unwrap())
    );
}

#[tokio::test]
async fn migrated_legacy_cache_can_be_reinstalled_before_its_first_successful_sync() {
    for changed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old");
        let (_, _, old) = legacy_install(&old_root);
        let runtime = Path::new(old["runtime"]["codex_link"].as_str().unwrap());
        fs::write(
            runtime.join(CLAUDE_PLUGIN_MANIFEST_PATH),
            r#"{"version":"1.0","name":"demo"}"#,
        )
        .unwrap();
        if changed {
            fs::write(
                runtime.join("skills/demo/SKILL.md"),
                "preserve changed cache",
            )
            .unwrap();
        }
        let new_root = temp.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let store = store(&new_root, true);
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let removed = handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap();
        assert_eq!(removed["success"], true, "{removed}");
        store.reconcile_managed_plugin_runtimes().unwrap();
        let current_runtime = new_root.join("codex/plugins/cache/wegent/demo/1.0");
        let before = tree_fingerprint(&current_runtime).unwrap();
        let result = handler.apply_sync(payload("demo")).await.unwrap();
        assert_eq!(result["success"], !changed, "{result}");
        if changed {
            assert_eq!(tree_fingerprint(&current_runtime).unwrap(), before);
        }
    }
}

#[tokio::test]
async fn legacy_update_preserves_unrelated_sources_and_requires_independent_content_evidence() {
    for alteration in [
        "store-content",
        "cache-content",
        "identity",
        "foreign-owner",
        "foreign-link",
        "unmanaged",
        "nested-link",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (store, market, entry) = legacy_install(temp.path());
        let source = PathBuf::from(entry["store_path"].as_str().unwrap());
        let cache = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
        let mut manifest = store.manifest.load().unwrap();
        match alteration {
            "store-content" => {
                fs::write(source.join("skills/demo/SKILL.md"), "changed source").unwrap()
            }
            "cache-content" => {
                fs::write(cache.join("skills/demo/SKILL.md"), "changed cache").unwrap()
            }
            "identity" => fs::write(
                source.join(CODEX_PLUGIN_MANIFEST_PATH),
                r#"{"name":"another","version":"1.0"}"#,
            )
            .unwrap(),
            "foreign-owner" => {
                manifest["plugin_runtime_owners"] =
                    json!({cache.to_string_lossy().as_ref():"another@wegent"})
            }
            "foreign-link" => {
                remove_existing_path(&market).unwrap();
                std::os::unix::fs::symlink(&cache, &market).unwrap();
                manifest["plugins"] = json!({});
            }
            "unmanaged" => {
                manifest["plugins"]["demo@wegent"]["managed"] = json!(false);
                fs::remove_file(store.manifest.path.with_file_name("manifest.json")).unwrap();
            }
            "nested-link" => std::os::unix::fs::symlink(&cache, source.join("external")).unwrap(),
            _ => unreachable!(),
        }
        store.manifest.save(manifest.clone()).unwrap();
        let before = fs::read_link(&market).unwrap();
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let result = handler.apply_sync(payload("demo")).await.unwrap();
        assert_eq!(result["success"], false, "{alteration}: {result}");
        assert_eq!(fs::read_link(&market).unwrap(), before);
        assert!(source.is_dir());
        assert_eq!(
            store.manifest.load().unwrap()["plugins"],
            manifest["plugins"]
        );
    }
}

#[tokio::test]
async fn legacy_sources_support_relative_links_copies_and_relocated_store_paths() {
    for layout in [
        "relative",
        "directory-copy",
        "relocated",
        "relocated-dangling",
        "relocated-dangling-altered",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old");
        let (mut store, mut market, old) = legacy_install(&old_root);
        if layout == "relative" {
            remove_existing_path(&market).unwrap();
            std::os::unix::fs::symlink(
                "../../../../../executor/capabilities/store/plugins/41-wegent-demo-1.0",
                &market,
            )
            .unwrap();
        } else if layout == "directory-copy" {
            remove_existing_path(&market).unwrap();
            copy_dir_atomic(Path::new(old["store_path"].as_str().unwrap()), &market).unwrap();
        } else {
            let new_root = temp.path().join("new");
            fs::rename(&old_root, &new_root).unwrap();
            store = super::super::tests::store(&new_root, true);
            market = store.codex_marketplace_dir("wegent").join("plugins/demo");
            if layout == "relocated" {
                remove_existing_path(&market).unwrap();
                std::os::unix::fs::symlink(
                    new_root.join("executor/capabilities/store/plugins/41-wegent-demo-1.0"),
                    &market,
                )
                .unwrap();
            }
            if layout == "relocated-dangling-altered" {
                fs::write(new_root.join("executor/capabilities/store/plugins/41-wegent-demo-1.0/skills/demo/SKILL.md"), "preserve unrelated source").unwrap();
            }
        }
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let result = handler.apply_sync(payload("demo")).await.unwrap();
        if layout == "relocated-dangling-altered" {
            assert_eq!(result["success"], false, "{result}");
            assert_eq!(
                fs::read_link(&market).unwrap(),
                Path::new(old["store_path"].as_str().unwrap())
            );
            continue;
        }
        assert_eq!(result["success"], true, "{layout}: {result}");
        let current = store.manifest.load().unwrap();
        let runtime = Path::new(
            current["plugins"]["demo@wegent"]["runtime"]["codex_link"]
                .as_str()
                .unwrap(),
        );
        if layout == "directory-copy" {
            assert!(same_runtime_contents(&market, runtime).unwrap());
        } else {
            assert_eq!(fs::read_link(&market).unwrap(), runtime);
        }
        assert_eq!(current["plugins"]["demo@wegent"]["enabled"], false);
    }
}

#[test]
fn legacy_directory_copy_checks_later_records_without_hiding_filesystem_errors() {
    for change in ["none", "identity", "symlink", "parent-file"] {
        let temp = tempfile::tempdir().unwrap();
        let (store, market, old) = legacy_install(temp.path());
        let source = Path::new(old["store_path"].as_str().unwrap());
        let source_before = tree_fingerprint(source).unwrap();
        remove_existing_path(&market).unwrap();
        copy_dir_atomic(source, &market).unwrap();
        match change {
            "identity" => write_json(
                &market.join(CODEX_PLUGIN_MANIFEST_PATH),
                &json!({"name":"other","version":"1.0"}),
            )
            .unwrap(),
            "symlink" => std::os::unix::fs::symlink(source, market.join("external")).unwrap(),
            "parent-file" => {
                remove_existing_path(&market.join(".codex-plugin")).unwrap();
                fs::write(market.join(".codex-plugin"), "preserve this file").unwrap();
            }
            _ => (),
        }
        let mut active = old.clone();
        active["version"] = json!("2.0");
        active["store_path"] = json!(temp
            .path()
            .join("executor/capabilities/store/plugins/41-wegent-demo-2.0"));
        active["previous"] = old.clone();
        let spec = checked_spec("demo@wegent", &active).unwrap();
        let mut manifest = store.manifest.load().unwrap();
        manifest["plugins"]["demo@wegent"] = active.clone();
        let result = store.owns_legacy_marketplace_source(&spec, &market, &active, &manifest);
        match change {
            "none" => assert!(result.unwrap()),
            "identity" => assert!(!result.unwrap()),
            "symlink" => assert!(matches!(
                result,
                Err(CapabilitySyncError::InvalidPayload(_))
            )),
            "parent-file" => {
                assert!(matches!(result, Err(CapabilitySyncError::Io(_))));
                assert_eq!(
                    fs::read_to_string(market.join(".codex-plugin")).unwrap(),
                    "preserve this file"
                );
            }
            _ => unreachable!(),
        }
        assert_eq!(tree_fingerprint(source).unwrap(), source_before);
    }
}

#[tokio::test]
async fn failed_legacy_publication_rolls_back_and_can_recover_without_mutating_the_source() {
    let temp = tempfile::tempdir().unwrap();
    let (store, market, old) = legacy_install(temp.path());
    let before = store.manifest.load().unwrap();
    let source = Path::new(old["store_path"].as_str().unwrap());
    let cache = Path::new(old["runtime"]["codex_link"].as_str().unwrap());
    let source_before = tree_fingerprint(source).unwrap();
    let cache_before = tree_fingerprint(cache).unwrap();
    let config = temp.path().join("codex/config.toml");
    fs::write(&config, "[plugins\n").unwrap();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let failed = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(failed["success"], false, "{failed}");
    assert_eq!(store.manifest.load().unwrap()["plugins"], before["plugins"]);
    assert_eq!(fs::read_link(&market).unwrap(), source);
    assert_eq!(tree_fingerprint(source).unwrap(), source_before);
    assert_eq!(tree_fingerprint(cache).unwrap(), cache_before);
    assert_eq!(fs::read_to_string(&config).unwrap(), "[plugins\n");
    fs::write(&config, "# repaired native configuration\n").unwrap();
    let recovered = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(recovered["success"], true, "{recovered}");
    assert_eq!(tree_fingerprint(source).unwrap(), source_before);
}

#[tokio::test]
async fn same_version_legacy_update_authenticates_the_previous_cache_against_its_private_store() {
    use std::io::{Cursor, Write};
    for (changed_cache, shared) in [false, true]
        .into_iter()
        .flat_map(|changed| [false, true].map(move |shared| (changed, shared)))
    {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old");
        let (original, original_market, mut old) = legacy_install(&old_root);
        fs::write(
            Path::new(old["runtime"]["codex_link"].as_str().unwrap())
                .join(CLAUDE_PLUGIN_MANIFEST_PATH),
            r#"{"version":"1.0","name":"demo"}"#,
        )
        .unwrap();
        if shared {
            let package = crate::services::workbench::publish_plugin_archive(
                &old_root.join("workbench"),
                &archive("demo"),
                None,
            )
            .unwrap();
            old["store_path"] = json!(package.path);
            old["checksum"] = json!(package.archive_hash);
            original
                .manifest
                .save(json!({"version":2,"plugins":{"demo@wegent":old},"skills":{},"mcps":{}}))
                .unwrap();
            remove_existing_path(&original_market).unwrap();
            std::os::unix::fs::symlink(
                old["runtime"]["codex_link"].as_str().unwrap(),
                &original_market,
            )
            .unwrap();
        }
        let new_root = temp.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let store = store(&new_root, true);
        let market = store.codex_marketplace_dir("wegent").join("plugins/demo");
        let source = new_root.join("executor/capabilities/store/plugins/41-wegent-demo-1.0");
        if !shared {
            remove_existing_path(&market).unwrap();
            std::os::unix::fs::symlink(&source, &market).unwrap();
        }
        let runtime = new_root.join("codex/plugins/cache/wegent/demo/1.0");
        if changed_cache {
            fs::write(
                runtime.join("skills/demo/SKILL.md"),
                "unrelated cache content",
            )
            .unwrap();
        }
        let mut package = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, contents) in [
            (
                ".codex-plugin/plugin.json",
                r#"{"name":"demo","version":"1.0"}"#,
            ),
            ("skills/demo/SKILL.md", "new same-version capability"),
        ] {
            package
                .start_file(path, zip::write::FileOptions::default())
                .unwrap();
            package.write_all(contents.as_bytes()).unwrap();
        }
        let bytes = package.finish().unwrap().into_inner();
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(bytes),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let result = handler.apply_sync(payload("demo")).await.unwrap();
        assert_eq!(
            result["success"], !changed_cache,
            "shared={shared}: {result}"
        );
        assert_eq!(
            fs::read_to_string(source.join("skills/demo/SKILL.md")).unwrap(),
            "plugin capability"
        );
        assert_eq!(
            fs::read_to_string(runtime.join("skills/demo/SKILL.md")).unwrap(),
            if changed_cache {
                "unrelated cache content"
            } else {
                "new same-version capability"
            }
        );
    }
}

#[tokio::test]
async fn old_manifest_serialization_can_migrate_without_authorizing_changed_content() {
    use std::io::{Cursor, Write};
    for (change, shared) in [
        "format-only",
        "manifest-value",
        "primary-version",
        "secondary-version",
        "skill-content",
        "cache-content",
    ]
    .into_iter()
    .flat_map(|change| [false, true].map(|shared| (change, shared)))
    {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old");
        let (original, _, mut entry) = legacy_install(&old_root);
        let source = PathBuf::from(entry["store_path"].as_str().unwrap());
        let runtime = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
        let native = r#"{"name":"demo","version":"1.0","description":"old serializer","skills":"./skills/"}"#;
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, text) in [
            (CODEX_PLUGIN_MANIFEST_PATH, native),
            (
                CLAUDE_PLUGIN_MANIFEST_PATH,
                r#"{"name":"demo","version":"2.0","description":"old serializer","skills":"./skills/"}"#,
            ),
            ("skills/demo/SKILL.md", "original skill"),
        ] {
            archive
                .start_file(path, zip::write::FileOptions::default())
                .unwrap();
            archive.write_all(text.as_bytes()).unwrap();
        }
        let archive = archive.finish().unwrap().into_inner();
        extract_plugin_zip(&archive, &source).unwrap();
        // 0.5.0 serializes Claude manifests with lexicographically sorted keys.
        let mut generated: Value =
            serde_json::from_slice(&fs::read(source.join(CLAUDE_PLUGIN_MANIFEST_PATH)).unwrap())
                .unwrap();
        generated.sort_all_objects();
        write_json(&source.join(CLAUDE_PLUGIN_MANIFEST_PATH), &generated).unwrap();
        copy_dir_atomic(&source, &runtime).unwrap();
        let published = crate::services::workbench::publish_plugin_archive(
            &old_root.join("workbench"),
            &archive,
            None,
        )
        .unwrap();
        entry["checksum"] = json!(published.archive_hash);
        if shared {
            entry["store_path"] = json!(published.path);
        }
        write_json(
            &original.manifest.path.with_file_name("manifest.json"),
            &json!({"version":1,"plugins":{"demo@wegent":entry},"skills":{},"mcps":{}}),
        )
        .unwrap();
        if shared {
            original
                .manifest
                .save(json!({"version":2,"plugins":{"demo@wegent":entry},"skills":{},"mcps":{}}))
                .unwrap();
        }
        match change {
            "primary-version" => {
                let mut primary: Value = serde_json::from_slice(
                    &fs::read(source.join(CODEX_PLUGIN_MANIFEST_PATH)).unwrap(),
                )
                .unwrap();
                primary["version"] = json!("9.0");
                write_json(&source.join(CODEX_PLUGIN_MANIFEST_PATH), &primary).unwrap();
                copy_dir_atomic(&source, &runtime).unwrap();
            }
            "secondary-version" => {
                generated["version"] = json!("9.0");
                write_json(&source.join(CLAUDE_PLUGIN_MANIFEST_PATH), &generated).unwrap();
                copy_dir_atomic(&source, &runtime).unwrap();
            }
            "manifest-value" => {
                generated["description"] = json!("unrelated metadata");
                write_json(&source.join(CLAUDE_PLUGIN_MANIFEST_PATH), &generated).unwrap();
                copy_dir_atomic(&source, &runtime).unwrap();
            }
            "skill-content" => {
                fs::write(source.join("skills/demo/SKILL.md"), "unrelated skill").unwrap();
                copy_dir_atomic(&source, &runtime).unwrap();
            }
            "cache-content" => {
                fs::write(runtime.join("skills/demo/SKILL.md"), "unrelated cache").unwrap()
            }
            _ => (),
        }
        let source_before = tree_fingerprint(&source).unwrap();
        let new_root = temp.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let store = store(&new_root, true);
        let source = new_root.join("executor/capabilities/store/plugins/41-wegent-demo-1.0");
        let market = store.codex_marketplace_dir("wegent").join("plugins/demo");
        remove_existing_path(&market).unwrap();
        let linked = if shared {
            new_root.join("codex/plugins/cache/wegent/demo/1.0")
        } else {
            source.clone()
        };
        std::os::unix::fs::symlink(&linked, &market).unwrap();
        if shared && change == "format-only" {
            let report = store.reconcile_managed_plugin_runtimes().unwrap();
            assert!(report.failed.is_empty(), "{:?}", report.failed);
            assert_eq!(report.restored, vec!["demo@wegent"]);
        }
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut request = payload("demo");
        request["plugins"][0]["checksum"] = entry["checksum"].clone();
        let result = handler.apply_sync(request).await.unwrap();
        assert_eq!(
            result["success"],
            change == "format-only",
            "shared={shared} {change}: {result}"
        );
        assert_eq!(tree_fingerprint(&source).unwrap(), source_before);
    }
}
