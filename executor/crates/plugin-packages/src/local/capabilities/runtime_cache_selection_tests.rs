// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::tests::{archive_payload, payload, store, Packages};
use super::*;

async fn install(store: &GlobalCapabilityStore, version: &str) -> Value {
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive_payload("demo", version)),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["version"] = json!(version);
    let result = handler.apply_sync(request).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    result
}

fn desired(version: &str) -> PluginSyncSpec {
    let mut request = payload("demo");
    request["plugins"][0]["version"] = json!(version);
    PluginSyncSpec::from_value(&request["plugins"][0]).unwrap()
}

#[test]
fn ordering_matches_native_semver_lexical_and_local_selection() {
    for (candidate, selected, expected) in [
        ("10.0.0", "2.0.0", true),
        ("2.0.0", "10.0.0", false),
        ("1.0.0", "1.0.0-beta.1", true),
        ("1.0.0+build", "1.0.0", true),
        ("local", "99.0.0", true),
        ("99.0.0", "local", false),
        ("1.1", "1.0", true),
        ("1.0", "1.0", false),
    ] {
        assert_eq!(
            preferred(candidate, selected),
            expected,
            "{candidate} / {selected}"
        );
    }
}

#[tokio::test]
async fn manual_pin_retains_higher_runtime_data_and_survives_home_relocation() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let current = store(&old, true);
    install(&current, "1.0.0").await;
    install(&current, "2.0.0").await;
    let higher = current.plugin_codex_link(&desired("2.0.0"));
    fs::write(
        higher.join("runtime-only.txt"),
        "retain this writable cache data",
    )
    .unwrap();
    let before = tree_fingerprint(&higher).unwrap();

    install(&current, "1.0.0").await;

    assert!(!higher.exists());
    let manifest = current.manifest.load().unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    assert_eq!(entry["version"], "1.0.0");
    assert_eq!(
        entry["runtime"]["codex_link"],
        json!(current.plugin_codex_link(&desired("1.0.0")))
    );
    let archive = Path::new(entry["previous"]["runtime"]["codex_link"].as_str().unwrap());
    assert!(is_retained(archive));
    assert_eq!(tree_fingerprint(archive).unwrap(), before);
    assert!(!pending(&current, "demo@wegent"));
    assert_eq!(install(&current, "1.0.0").await["changed"], false);
    let next = temp.path().join("new");
    fs::rename(&old, &next).unwrap();
    let relocated = store(&next, true);
    let report = relocated.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let manifest = relocated.manifest.load().unwrap();
    let archive = Path::new(
        manifest["plugins"]["demo@wegent"]["previous"]["runtime"]["codex_link"]
            .as_str()
            .unwrap(),
    );
    assert!(archive.starts_with(&next));
    assert_eq!(tree_fingerprint(archive).unwrap(), before);
    assert_eq!(
        manifest["plugin_runtime_owners"][archive.to_string_lossy().as_ref()],
        "demo@wegent"
    );
}

#[tokio::test]
async fn a_higher_unmanaged_cache_is_never_moved_or_claimed() {
    let temp = tempfile::tempdir().unwrap();
    let current = store(temp.path(), true);
    install(&current, "1.0.0").await;
    let foreign = current.plugin_codex_link(&desired("9.0.0"));
    fs::create_dir_all(&foreign).unwrap();
    fs::write(foreign.join("personal.txt"), "keep").unwrap();
    let before = tree_fingerprint(&foreign).unwrap();

    let report = current.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed["demo@wegent"].contains("unmanaged"));
    assert_eq!(tree_fingerprint(&foreign).unwrap(), before);
    assert!(!pending(&current, "demo@wegent"));
}

#[tokio::test]
async fn interrupted_selection_restores_the_original_native_version() {
    let temp = tempfile::tempdir().unwrap();
    let current = store(temp.path(), true);
    install(&current, "2.0.0").await;
    let higher = current.plugin_codex_link(&desired("2.0.0"));
    let before = tree_fingerprint(&higher).unwrap();
    let manifest = current.manifest.load().unwrap();
    let selection = Selection::prepare(&current, &desired("1.0.0"), &manifest)
        .unwrap()
        .unwrap();
    selection.retire(&current).unwrap();
    assert!(!higher.exists());

    let report = current.reconcile_managed_plugin_runtimes().unwrap();

    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(tree_fingerprint(&higher).unwrap(), before);
    assert!(!pending(&current, "demo@wegent"));
    assert_eq!(
        current.manifest.load().unwrap()["plugins"]["demo@wegent"]["version"],
        "2.0.0"
    );
}

#[tokio::test]
async fn recovery_preserves_user_changes_and_rejects_foreign_journal_paths() {
    for corruption in ["archive-content", "foreign-path", "schema"] {
        let temp = tempfile::tempdir().unwrap();
        let current = store(temp.path(), true);
        install(&current, "2.0.0").await;
        let manifest = current.manifest.load().unwrap();
        let selection = Selection::prepare(&current, &desired("1.0.0"), &manifest)
            .unwrap()
            .unwrap();
        selection.retire(&current).unwrap();
        let archive = &selection.record.versions[0].archive;
        let foreign = temp.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("private.txt"), "preserve foreign data").unwrap();
        if corruption == "archive-content" {
            fs::write(
                archive.join("payload.txt"),
                "user changes after interruption",
            )
            .unwrap();
        } else {
            let mut record = serde_json::to_value(&selection.record).unwrap();
            if corruption == "schema" {
                record["schema_version"] = json!(99);
            } else {
                record["versions"][0]["source"] = json!(foreign);
            }
            fs::write(&selection.path, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        let archive_before = tree_fingerprint(archive).unwrap();
        let foreign_before = tree_fingerprint(&foreign).unwrap();

        let report = current.reconcile_managed_plugin_runtimes().unwrap();

        assert!(report.failed.contains_key("demo@wegent"));
        assert!(pending(&current, "demo@wegent"));
        assert_eq!(tree_fingerprint(archive).unwrap(), archive_before);
        assert_eq!(tree_fingerprint(&foreign).unwrap(), foreign_before);
    }
}

#[tokio::test]
async fn committed_selection_cannot_resurrect_a_later_uninstalled_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let current = store(temp.path(), true);
    install(&current, "1.0.0").await;
    let mut selected = current.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    install(&current, "2.0.0").await;
    let mut manifest = current.manifest.load().unwrap();
    let selection = Selection::prepare(&current, &desired("1.0.0"), &manifest)
        .unwrap()
        .unwrap();
    selection.retire(&current).unwrap();
    selection.record_commit(&mut manifest, &mut selected);
    manifest["plugins"] = json!({});
    current.manifest.save(manifest.clone()).unwrap();
    let archive = &selection.record.versions[0].archive;
    let before = tree_fingerprint(archive).unwrap();

    recover(&current, "demo@wegent", &manifest).unwrap();

    assert!(!current.plugin_codex_link(&desired("2.0.0")).exists());
    assert_eq!(tree_fingerprint(archive).unwrap(), before);
    assert!(!pending(&current, "demo@wegent"));
    assert!(current.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
}
