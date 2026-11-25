// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::tests::{archive, installed, payload, store, Packages};
use super::*;
use std::io::{Cursor, Write};

#[derive(Clone, Copy, Debug)]
enum McpConfig {
    Inline,
    External,
    Default,
    MixedDefault,
}

async fn installed_python_mcp(
    home: &Path,
    codex_only: bool,
    marker: &str,
    server: &str,
    managed: bool,
    config: McpConfig,
) -> GlobalCapabilityStore {
    let store =
        store(home, codex_only).with_managed_mcp_python(managed.then(|| home.join("executor-bin")));
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut manifest = json!({"name":"demo","version":"1.0","mcpServers":{
        server:{"command":"python3","cwd":"./","args":["scripts/server.py"]}
    }});
    if !matches!(config, McpConfig::Inline) {
        zip.start_file(".mcp.json", zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(
            json!({"mcpServers":manifest["mcpServers"]})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        if matches!(config, McpConfig::MixedDefault) {
            let mut claude = manifest.clone();
            claude.as_object_mut().unwrap().remove("mcpServers");
            zip.start_file(
                CLAUDE_PLUGIN_MANIFEST_PATH,
                zip::write::FileOptions::default(),
            )
            .unwrap();
            zip.write_all(claude.to_string().as_bytes()).unwrap();
        } else if matches!(config, McpConfig::External) {
            manifest["mcpServers"] = json!("./.mcp.json");
        } else {
            manifest.as_object_mut().unwrap().remove("mcpServers");
        }
    }
    for (path, body) in [
        (marker, manifest.to_string()),
        ("scripts/server.py", "pass\n".into()),
    ] {
        zip.start_file(path, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(zip.finish().unwrap().into_inner()),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["enabled"] = json!(true);
    assert_eq!(handler.apply_sync(request).await.unwrap()["success"], true);
    store
}

#[tokio::test]
async fn recovery_checks_generated_inline_mcp_manifests() {
    for source_marker in PLUGIN_MANIFEST_PATHS {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = installed_python_mcp(
            &home,
            true,
            source_marker,
            "service",
            true,
            McpConfig::Inline,
        )
        .await;
        let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
        let root = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
        let generated = PLUGIN_MANIFEST_PATHS
            .into_iter()
            .find(|path| *path != source_marker)
            .unwrap();
        let path = root.join(generated);
        let mut stale: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        stale["mcpServers"]["service"]["command"] = json!(home.join("old-executor"));
        write_json(&path, &stale).unwrap();

        let report = store.reconcile_managed_plugin_runtimes().unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.restored, ["demo@wegent"], "{generated}");
        let repaired: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            repaired["mcpServers"]["service"]["command"],
            json!(home.join("executor-bin"))
        );
        assert!(store
            .reconcile_managed_plugin_runtimes()
            .unwrap()
            .restored
            .is_empty());
    }
}

#[tokio::test]
async fn unavailable_mcp_source_does_not_clear_recovery_failure() {
    for missing in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = installed_python_mcp(
            &home,
            true,
            CODEX_PLUGIN_MANIFEST_PATH,
            "service",
            true,
            McpConfig::Inline,
        )
        .await;
        let mut manifest = store.manifest.load().unwrap();
        let entry = &manifest["plugins"]["demo@wegent"];
        let source = PathBuf::from(entry["store_path"].as_str().unwrap());
        let runtime = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap())
            .join(CODEX_PLUGIN_MANIFEST_PATH);
        let before = fs::read(&runtime).unwrap();
        manifest["plugins"]["demo@wegent"]["runtime_recovery_error"] = json!("previous failure");
        store.manifest.save(manifest).unwrap();
        if missing {
            fs::remove_dir_all(source).unwrap();
        } else {
            fs::write(source.join(CODEX_PLUGIN_MANIFEST_PATH), "{").unwrap();
        }

        let report = store.reconcile_managed_plugin_runtimes().unwrap();

        assert!(
            report.failed.contains_key("demo@wegent"),
            "missing={missing}"
        );
        assert!(report.restored.is_empty());
        assert!(
            store.manifest.load().unwrap()["plugins"]["demo@wegent"]["runtime_recovery_error"]
                .is_string()
        );
        assert_eq!(fs::read(runtime).unwrap(), before);
    }
}

#[tokio::test]
async fn incomplete_mcp_source_preserves_cached_runtime_and_error() {
    for config in [
        McpConfig::Inline,
        McpConfig::External,
        McpConfig::Default,
        McpConfig::MixedDefault,
    ] {
        for missing in [None, Some("scripts/server.py"), Some(".mcp.json")] {
            if matches!(config, McpConfig::Inline) && missing == Some(".mcp.json") {
                continue;
            }
            for codex_only in [true, false] {
                let temp = tempfile::tempdir().unwrap();
                let home = temp.path().join("home");
                let store = installed_python_mcp(
                    &home,
                    codex_only,
                    CODEX_PLUGIN_MANIFEST_PATH,
                    "service",
                    true,
                    config,
                )
                .await;
                let mut manifest = store.manifest.load().unwrap();
                let entry = &manifest["plugins"]["demo@wegent"];
                let source = PathBuf::from(entry["store_path"].as_str().unwrap());
                let runtime = PathBuf::from(
                    entry["runtime"][if codex_only {
                        "codex_link"
                    } else {
                        "claude_link"
                    }]
                    .as_str()
                    .unwrap(),
                );
                let path = runtime.join(if matches!(config, McpConfig::Inline) {
                    CODEX_PLUGIN_MANIFEST_PATH
                } else {
                    ".mcp.json"
                });
                let mut stale: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                stale["mcpServers"]["service"]["command"] = json!(home.join("old-executor"));
                write_json(&path, &stale).unwrap();
                if !codex_only && missing.is_some() {
                    fs::remove_file(runtime.join(CLAUDE_PLUGIN_MANIFEST_PATH)).unwrap();
                }
                let before = tree_fingerprint(&runtime).unwrap();
                manifest["plugins"]["demo@wegent"]["runtime_recovery_error"] =
                    json!("previous failure");
                store.manifest.save(manifest).unwrap();
                if let Some(missing) = missing {
                    fs::remove_file(source.join(missing)).unwrap();
                    if !codex_only {
                        assert!(
                            store.reconcile_managed_claude_plugins().is_err(),
                            "{config:?}: {missing}"
                        );
                    }
                }

                let report = store.reconcile_managed_plugin_runtimes().unwrap();

                if missing.is_some() {
                    assert!(
                        report.failed.contains_key("demo@wegent"),
                        "{config:?}: {missing:?}"
                    );
                    assert!(report.restored.is_empty());
                    assert_eq!(tree_fingerprint(&runtime).unwrap(), before);
                    assert!(store.manifest.load().unwrap()["plugins"]["demo@wegent"]
                        ["runtime_recovery_error"]
                        .is_string());
                } else {
                    assert!(report.failed.is_empty(), "{:?}", report.failed);
                    assert_eq!(report.restored, ["demo@wegent"]);
                    assert_ne!(tree_fingerprint(&runtime).unwrap(), before);
                    assert!(store.manifest.load().unwrap()["plugins"]["demo@wegent"]
                        ["runtime_recovery_error"]
                        .is_null());
                }
            }
        }
    }
}

#[tokio::test]
async fn inline_mcp_names_are_not_treated_as_configuration_wrappers() {
    for marker in PLUGIN_MANIFEST_PATHS {
        for name in ["service", "mcp_servers", "mcpServers"] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("home");
            let store =
                installed_python_mcp(&home, true, marker, name, true, McpConfig::Inline).await;
            let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
            let source = PathBuf::from(entry["store_path"].as_str().unwrap());
            let runtime = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
            for path in PLUGIN_MANIFEST_PATHS {
                let config: Value =
                    serde_json::from_slice(&fs::read(runtime.join(path)).unwrap()).unwrap();
                assert_eq!(
                    config["mcpServers"][name]["command"],
                    json!(home.join("executor-bin")),
                    "{marker}: {name}: {path}"
                );
                assert_eq!(
                    config["mcpServers"][name]["args"],
                    json!(["plugin-python", "--mcp", "scripts/server.py"])
                );
            }
            let original: Value =
                serde_json::from_slice(&fs::read(source.join(marker)).unwrap()).unwrap();
            assert_eq!(original["mcpServers"][name]["command"], "python3");
        }
    }
}

#[tokio::test]
async fn claude_restore_projects_existing_caches_and_refreshes_the_launcher() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let store = installed_python_mcp(
        &home,
        false,
        CLAUDE_PLUGIN_MANIFEST_PATH,
        "service",
        false,
        McpConfig::Inline,
    )
    .await;
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let runtime = PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap());
    for launcher in ["executor-bin", "updated-executor-bin"] {
        let store = store
            .clone()
            .with_managed_mcp_python(Some(home.join(launcher)));

        let restored = store.reconcile_managed_claude_plugins().unwrap();

        assert_eq!(restored, ["demo@wegent"]);
        for path in PLUGIN_MANIFEST_PATHS {
            let config: Value =
                serde_json::from_slice(&fs::read(runtime.join(path)).unwrap()).unwrap();
            assert_eq!(
                config["mcpServers"]["service"]["command"],
                json!(home.join(launcher))
            );
        }
        assert!(store.reconcile_managed_claude_plugins().unwrap().is_empty());
    }
}

#[tokio::test]
async fn claude_restore_preserves_the_cache_when_its_source_is_unreadable() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let store = installed_python_mcp(
        &home,
        false,
        CLAUDE_PLUGIN_MANIFEST_PATH,
        "service",
        true,
        McpConfig::Inline,
    )
    .await;
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let runtime = PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap())
        .join(CLAUDE_PLUGIN_MANIFEST_PATH);
    let before = fs::read(&runtime).unwrap();
    let source = PathBuf::from(entry["store_path"].as_str().unwrap());
    fs::write(source.join(CLAUDE_PLUGIN_MANIFEST_PATH), "{").unwrap();

    assert!(store.reconcile_managed_claude_plugins().is_err());

    assert_eq!(fs::read(runtime).unwrap(), before);
}

#[tokio::test]
async fn healthy_current_runtime_does_not_require_or_verify_shared_package() {
    for (codex_only, managed) in [(false, false), (true, false), (false, true), (true, true)] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), codex_only)
            .await
            .with_managed_mcp_python(managed.then(|| temp.path().join("executor-bin")));
        let before = fs::read(&store.manifest.path).unwrap();
        let manifest = store.manifest.load().unwrap();
        let package = Path::new(
            manifest["plugins"]["demo@wegent"]["store_path"]
                .as_str()
                .unwrap(),
        );
        fs::remove_dir_all(package).unwrap();

        let report = store.reconcile_managed_plugin_runtimes().unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(report.restored.is_empty());
        assert_eq!(fs::read(&store.manifest.path).unwrap(), before);
        assert!(!package.exists());
    }
}

#[tokio::test]
async fn unused_corrupted_package_is_checked_only_when_runtime_repair_is_needed() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let manifest = store.manifest.load().unwrap();
    let before = fs::read(&store.manifest.path).unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    let package = Path::new(entry["store_path"].as_str().unwrap());
    fs::write(package.join("skills/demo/SKILL.md"), "corrupted package").unwrap();

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert!(report.restored.is_empty());
    assert_eq!(fs::read(&store.manifest.path).unwrap(), before);
    let spec = checked_spec("demo@wegent", entry).unwrap();
    let runtime = store.plugin_codex_link(&spec);
    fs::remove_dir_all(&runtime).unwrap();

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.contains_key("demo@wegent"));
    assert!(report.restored.is_empty());
    assert!(!runtime.exists());
}

#[tokio::test]
async fn healthy_legacy_private_runtime_clears_stale_error_without_shared_archive() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let legacy = GlobalCapabilityStore::new(
        home.join("executor/capabilities/manifest-v2.json"),
        home.join("claude/skills"),
    )
    .with_plugins_dir(home.join("claude/plugins"))
    .with_codex_plugins_dir(home.join("codex/plugins"));
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        legacy.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        handler.apply_sync(payload("demo")).await.unwrap()["success"],
        true
    );
    let mut manifest = legacy.manifest.load().unwrap();
    assert!(manifest["plugins"]["demo@wegent"].get("checksum").is_none());
    manifest["plugins"]["demo@wegent"]["runtime_recovery_error"] = json!("archive is missing");
    legacy.manifest.save(manifest).unwrap();
    let upgraded = legacy.with_workbench_root(home.join("workbench"));

    let report = upgraded.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.restored, vec!["demo@wegent"]);
    let manifest = upgraded.manifest.load().unwrap();
    assert!(manifest["plugins"]["demo@wegent"]
        .get("runtime_recovery_error")
        .is_none());
    assert!(!home.join("workbench").exists());
    assert!(home
        .join("codex/plugins/cache/wegent/demo/1.0/skills/demo/SKILL.md")
        .is_file());
}

#[tokio::test]
async fn relocation_does_not_verify_unavailable_previous_package() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let mut manifest = original.manifest.load().unwrap();
    let mut previous = manifest["plugins"]["demo@wegent"].clone();
    previous["version"] = json!("0.9");
    previous["checksum"] = json!(format!("sha256:{}", "0".repeat(64)));
    let previous_spec = checked_spec("demo@wegent", &previous).unwrap();
    previous["runtime"]["codex_link"] = json!(original.plugin_codex_link(&previous_spec));
    previous["store_path"] = json!(original
        .current_shared_plugin_path(previous_spec.checksum.as_deref().unwrap())
        .unwrap());
    manifest["plugins"]["demo@wegent"]["previous"] = previous;
    original.manifest.save(manifest).unwrap();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.restored, vec!["demo@wegent"]);
    let manifest = store.manifest.load().unwrap();
    let previous = &manifest["plugins"]["demo@wegent"]["previous"];
    assert_eq!(
        previous["runtime"]["codex_link"],
        json!(store.plugin_codex_link(&previous_spec))
    );
    assert_eq!(
        previous["store_path"],
        json!(store
            .current_shared_plugin_path(previous_spec.checksum.as_deref().unwrap())
            .unwrap())
    );
    assert!(!old.exists());
}

#[tokio::test]
async fn relocation_still_rejects_corrupted_active_package() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let manifest = original.manifest.load().unwrap();
    let old_runtime = manifest["plugins"]["demo@wegent"]["runtime"].clone();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let package = store
        .current_shared_plugin_path(spec.checksum.as_deref().unwrap())
        .unwrap();
    fs::write(package.join("skills/demo/SKILL.md"), "corrupted package").unwrap();

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.contains_key("demo@wegent"));
    assert!(report.restored.is_empty());
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"]["runtime"],
        old_runtime
    );
    assert_eq!(
        fs::read_to_string(store.plugin_codex_link(&spec).join("skills/demo/SKILL.md")).unwrap(),
        "plugin capability"
    );
    assert!(!old.exists());
}

#[tokio::test]
async fn malformed_archived_checksum_does_not_block_active_relocation() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let mut manifest = original.manifest.load().unwrap();
    let mut previous = manifest["plugins"]["demo@wegent"].clone();
    previous["version"] = json!("0.9");
    previous["checksum"] = json!("malformed archived checksum");
    let historical_store = previous["store_path"].clone();
    manifest["plugins"]["demo@wegent"]["previous"] = previous;
    original.manifest.save(manifest).unwrap();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.restored, vec!["demo@wegent"]);
    let manifest = store.manifest.load().unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    assert_eq!(entry["previous"]["store_path"], historical_store);
    assert!(Path::new(entry["runtime"]["codex_link"].as_str().unwrap()).starts_with(&new));
    assert!(!old.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn relocation_preserves_configured_claude_home_alias() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    installed(&old, false).await;
    fs::rename(&old, &new).unwrap();
    fs::create_dir(&old).unwrap();
    std::os::unix::fs::symlink(new.join("claude"), old.join("claude")).unwrap();
    let store = store(&new, false).with_plugins_dir(old.join("claude/plugins"));

    let report = store.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.restored, vec!["demo@wegent"]);
    let manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    assert_eq!(
        manifest["plugins"]["demo@wegent"]["runtime"]["claude_link"],
        json!(store.plugin_runtime_link(&spec))
    );
    assert!(old.join("claude").is_symlink());
    assert!(!old.join("codex").exists());
    assert!(store
        .plugin_codex_link(&spec)
        .join("skills/demo/SKILL.md")
        .is_file());
}

#[cfg(unix)]
#[test]
fn configured_root_alias_does_not_allow_descendant_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("current");
    let alias = temp.path().join("configured");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("plugins")).unwrap();
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    assert!(safe_managed_path(&alias, &alias.join("plugins/cache/demo"), false).is_ok());
    std::os::unix::fs::symlink(&outside, root.join("plugins/cache")).unwrap();

    assert!(safe_managed_path(&alias, &alias.join("plugins/cache/demo"), false).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
}
