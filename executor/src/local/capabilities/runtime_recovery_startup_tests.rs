// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::tests::{archive, installed, payload, store, Packages};
use super::*;

#[tokio::test]
async fn healthy_current_runtime_does_not_require_or_verify_shared_package() {
    for codex_only in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), codex_only).await;
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
    let handler =
        CapabilitySyncHandler::with_package_provider("", legacy.clone(), Packages(archive("demo")));
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
