// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;

#[path = "scope_tests.rs"]
mod scope_tests;

#[derive(Default)]
struct Provider {
    calls: AtomicUsize,
    fail: AtomicBool,
}

impl CapabilityPackageProvider for Provider {
    fn stage_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
        _target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("Unexpected skill")) })
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            if self.fail.load(Ordering::SeqCst) {
                return Err(invalid("Test download failure"));
            }
            // The store verifies package identity, so each fixture plugin
            // downloads an archive whose manifest declares the same name.
            let name = path.rsplit('/').next().unwrap_or("alpha");
            Ok(package(name))
        })
    }
}

fn package(name: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            ".claude-plugin/plugin.json",
            zip::write::FileOptions::default(),
        )
        .unwrap();
    let manifest = format!(r#"{{"name":"{name}","version":"1.0.0"}}"#);
    archive.write_all(manifest.as_bytes()).unwrap();
    archive
        .start_file("payload.txt", zip::write::FileOptions::default())
        .unwrap();
    archive.write_all(b"valid plugin contents").unwrap();
    archive.finish().unwrap().into_inner()
}

fn plugin(name: &str, id: i64) -> Value {
    json!({"name": name, "marketplace": "wework", "version": "1.0.0",
        "installed_plugin_id": id, "checksum": sha256_digest(&package(name)), "download_path": format!("/test/package/{name}")})
}

fn delta(generation: u64, plugins: Vec<Value>, removals: Vec<Value>) -> Value {
    json!({"scope": "plugin_delta", "mode": "merge", "plugins": plugins,
        "removed_plugins": removals,
        "plugin_sync": {"version": 2, "generation": generation, "complete": false}})
}

fn complete(generation: u64, plugins: Vec<Value>) -> Value {
    json!({"scope": "plugins", "mode": "merge", "plugins": plugins,
        "plugin_sync": {"version": 2, "generation": generation, "complete": true}})
}

fn fixture() -> (tempfile::TempDir, CapabilitySyncHandler<Provider>) {
    let root = tempfile::tempdir().unwrap();
    let store = GlobalCapabilityStore::new(
        root.path().join("capabilities/manifest.json"),
        root.path().join(".claude/skills"),
    )
    .with_store_dir(root.path().join("store"));
    (
        root,
        CapabilitySyncHandler::with_package_provider("test", store, Provider::default()),
    )
}

#[tokio::test]
async fn different_plugin_deltas_may_arrive_out_of_order() {
    let (_root, handler) = fixture();
    assert_eq!(
        handler
            .apply_sync(delta(11, vec![plugin("beta", 2)], vec![]))
            .await
            .unwrap()["success"],
        true
    );
    assert_eq!(
        handler
            .apply_sync(delta(10, vec![plugin("alpha", 1)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
    let manifest = handler.store.manifest.load().unwrap();
    assert_eq!(
        manifest["plugins"]["alpha@wework"]["plugin_sync_generation"],
        10
    );
    assert_eq!(
        manifest["plugins"]["beta@wework"]["plugin_sync_generation"],
        11
    );
}

#[tokio::test]
async fn complete_snapshot_cannot_remove_a_newer_delta() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(11, vec![plugin("beta", 2)], vec![]))
        .await
        .unwrap();
    let result = handler
        .apply_sync(complete(10, vec![plugin("alpha", 1)]))
        .await
        .unwrap();
    assert!(result["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == "beta" && item["status"] == "superseded"));
    assert!(handler.store.manifest.load().unwrap()["plugins"]["beta@wework"].is_object());
    let old = handler
        .apply_sync(delta(9, vec![plugin("gamma", 3)], vec![]))
        .await
        .unwrap();
    assert_eq!(old["plugins"][0]["status"], "superseded");
}

#[tokio::test]
async fn pruned_tombstones_stay_fenced_by_the_complete_generation() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(1, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    handler
        .apply_sync(delta(3, vec![], vec![plugin("alpha", 1)]))
        .await
        .unwrap();
    handler
        .apply_sync(delta(4, vec![plugin("beta", 2)], vec![]))
        .await
        .unwrap();
    // A newer complete snapshot lets strictly older intents and tombstones go.
    handler
        .apply_sync(complete(10, vec![plugin("beta", 2)]))
        .await
        .unwrap();
    let manifest = handler.store.manifest.load().unwrap();
    let state = &manifest["plugin_sync"];
    assert!(state["removals"].get("1").is_none());
    assert!(state["entries"].get("alpha@wework").is_none());
    // The complete snapshot re-records live plugins at its own generation.
    assert_eq!(state["entries"]["beta@wework"]["generation"], 10);
    // The complete fence still supersedes delayed deltas for pruned records.
    let delayed = handler
        .apply_sync(delta(3, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    assert_eq!(delayed["plugins"][0]["status"], "superseded");
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
}

#[tokio::test]
async fn removal_tombstone_survives_restart_and_reinstall() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(1, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    let removal = plugin("alpha", 1);
    assert_eq!(
        handler
            .apply_sync(delta(3, vec![], vec![removal.clone()]))
            .await
            .unwrap()["plugins"][0]["status"],
        "removed"
    );
    let restarted = CapabilitySyncHandler::with_package_provider(
        "test",
        handler.store.clone(),
        Provider::default(),
    );
    assert_eq!(
        restarted
            .apply_sync(delta(2, vec![plugin("alpha", 1)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "superseded"
    );
    assert!(restarted.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
    assert_eq!(
        restarted
            .apply_sync(delta(4, vec![plugin("alpha", 2)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
    assert_eq!(
        restarted
            .apply_sync(delta(3, vec![], vec![removal]))
            .await
            .unwrap()["plugins"][0]["status"],
        "removed"
    );
    assert_eq!(
        restarted.store.manifest.load().unwrap()["plugins"]["alpha@wework"]["installed_plugin_id"],
        2
    );
    assert_eq!(
        restarted.store.manifest.load().unwrap()["plugin_sync"]["removals"]["1"]["generation"],
        3
    );
}

#[tokio::test]
async fn duplicate_inflight_requests_share_work_and_failed_requests_retry() {
    let (_root, handler) = fixture();
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    let payload = delta(1, vec![plugin("alpha", 1)], vec![]);
    let (first, second) = tokio::join!(
        handler.apply_sync(payload.clone()),
        handler.apply_sync(payload.clone())
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 1);
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
    handler.package_provider.fail.store(false, Ordering::SeqCst);
    let result = handler.apply_sync(payload).await.unwrap();
    assert_eq!(result["plugins"][0]["status"], "synced");
    assert_eq!(result["plugins"][0]["generation"], 1);
    assert_eq!(
        result["plugins"][0]["checksum"],
        sha256_digest(&package("alpha"))
    );
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn invalid_protocol_cannot_trigger_legacy_full_cleanup() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(5, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    let before = handler.store.manifest.load().unwrap();
    for payload in [
        json!({"scope": "plugins", "plugins": [], "plugin_sync": {"version": 3, "generation": 6, "complete": true}}),
        json!({"scope": "plugins", "plugins": [], "plugin_sync": {"version": 2, "generation": 0, "complete": true}}),
        json!({"scope": "plugins", "plugins": [], "plugin_sync": {"version": 2, "generation": 6}}),
        json!({"scope": "plugin_delta", "plugins": []}),
        json!({"scope": "plugins", "plugins": [], "plugin_sync": {"version": 2, "generation": 6, "complete": false}}),
    ] {
        assert!(handler.apply_sync(payload).await.is_err());
        assert_eq!(handler.store.manifest.load().unwrap(), before);
    }
}

#[tokio::test]
async fn failed_intents_fence_old_commands_and_allow_same_generation_retry() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(1, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    let mut updated = plugin("alpha", 1);
    updated["version"] = json!("2.0.0");
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    let failed = handler
        .apply_sync(delta(3, vec![updated.clone()], vec![]))
        .await
        .unwrap();
    assert_eq!(failed["plugins"][0]["status"], "failed");
    assert_eq!(
        handler.store.manifest.load().unwrap()["plugin_sync"]["entries"]["alpha@wework"]["pending"],
        true
    );
    let accepted = handler.store.manifest.load().unwrap();
    assert_eq!(
        handler
            .apply_sync(delta(2, vec![], vec![plugin("alpha", 1)]))
            .await
            .unwrap()["plugins"][0]["status"],
        "superseded"
    );
    assert_eq!(handler.store.manifest.load().unwrap(), accepted);
    assert_eq!(
        handler
            .apply_sync(delta(2, vec![plugin("alpha", 1)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "superseded"
    );
    handler.package_provider.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        handler
            .apply_sync(delta(3, vec![updated], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
    assert_eq!(
        handler.store.manifest.load().unwrap()["plugin_sync"]["entries"]["alpha@wework"]["pending"],
        false
    );
}

#[tokio::test]
async fn failed_complete_snapshot_still_fences_delayed_delta() {
    let (_root, handler) = fixture();
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        handler
            .apply_sync(complete(10, vec![plugin("alpha", 1)]))
            .await
            .unwrap()["success"],
        false
    );
    assert_eq!(
        handler
            .apply_sync(delta(9, vec![plugin("beta", 2)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "superseded"
    );
    handler.package_provider.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        handler
            .apply_sync(complete(10, vec![plugin("alpha", 1)]))
            .await
            .unwrap()["success"],
        true
    );
}

#[tokio::test]
async fn removal_overtaking_reinstall_fences_only_its_installed_id() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(5, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    assert_eq!(
        handler
            .apply_sync(delta(10, vec![], vec![plugin("alpha", 2)]))
            .await
            .unwrap()["plugins"][0]["status"],
        "removed"
    );
    let state = handler.store.manifest.load().unwrap();
    assert_eq!(state["plugins"]["alpha@wework"]["installed_plugin_id"], 1);
    assert_eq!(state["plugin_sync"]["removals"]["2"]["generation"], 10);
    let restarted = CapabilitySyncHandler::with_package_provider(
        "test",
        handler.store.clone(),
        Provider::default(),
    );
    assert_eq!(
        restarted
            .apply_sync(delta(9, vec![plugin("alpha", 2)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "superseded"
    );
    assert_eq!(
        restarted
            .apply_sync(delta(11, vec![plugin("alpha", 3)], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
    restarted
        .apply_sync(delta(12, vec![], vec![plugin("alpha", 1)]))
        .await
        .unwrap();
    assert_eq!(
        restarted.store.manifest.load().unwrap()["plugins"]["alpha@wework"]["installed_plugin_id"],
        3
    );
}

#[tokio::test]
async fn old_installation_cleanup_preserves_pending_reinstall_retry() {
    let (_root, handler) = fixture();
    handler
        .apply_sync(delta(5, vec![plugin("alpha", 1)], vec![]))
        .await
        .unwrap();
    let mut replacement = plugin("alpha", 2);
    replacement["version"] = json!("2.0.0");
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        handler
            .apply_sync(delta(9, vec![replacement.clone()], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "failed"
    );
    assert_eq!(
        handler
            .apply_sync(delta(10, vec![], vec![plugin("alpha", 1)]))
            .await
            .unwrap()["plugins"][0]["status"],
        "removed"
    );
    let state = handler.store.manifest.load().unwrap();
    assert!(state["plugins"].get("alpha@wework").is_none());
    assert_eq!(
        state["plugin_sync"]["entries"]["alpha@wework"]["installed_plugin_id"],
        2
    );
    assert_eq!(
        state["plugin_sync"]["entries"]["alpha@wework"]["generation"],
        9
    );
    assert_eq!(
        state["plugin_sync"]["entries"]["alpha@wework"]["pending"],
        true
    );
    handler.package_provider.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        handler
            .apply_sync(delta(9, vec![replacement], vec![]))
            .await
            .unwrap()["plugins"][0]["status"],
        "synced"
    );
}

#[tokio::test]
async fn cancelled_owner_wakes_waiters_and_leaves_request_retryable() {
    let (_root, handler) = fixture();
    let payload = delta(1, vec![plugin("alpha", 1)], vec![]);
    let mut owner = Box::pin(handler.apply_sync(payload.clone()));
    assert!(futures_util::poll!(&mut owner).is_pending());
    let mut waiter = Box::pin(handler.apply_sync(payload.clone()));
    assert!(futures_util::poll!(&mut waiter).is_pending());
    drop(owner);
    assert!(waiter.await.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(
        handler.apply_sync(payload).await.unwrap()["plugins"][0]["status"],
        "synced"
    );
}

#[tokio::test]
async fn legacy_payload_retains_legacy_ack_and_plugin_scope_semantics() {
    let (_root, handler) = fixture();
    let result = handler
        .apply_sync(json!({"mode": "merge", "plugins": [plugin("alpha", 1)]}))
        .await
        .unwrap();
    assert_eq!(
        result["plugins"][0],
        json!({"id": 1, "name": "alpha", "status": "synced"})
    );
    assert!(result.get("plugin_sync").is_none());
    handler
        .apply_sync(json!({"scope": "plugins", "plugins": []}))
        .await
        .unwrap();
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn account_switch_resets_ordering_namespace_and_rejects_old_handlers() {
    let (_root, account_a) = fixture();
    account_a
        .apply_sync(complete(100, vec![plugin("alpha", 1)]))
        .await
        .unwrap();
    account_a
        .apply_sync(delta(101, vec![], vec![plugin("beta", 2)]))
        .await
        .unwrap();
    let account_b = CapabilitySyncHandler::with_package_provider(
        "other-account",
        account_a.store.clone(),
        Provider::default(),
    );
    assert!(account_a.apply_sync(complete(101, vec![])).await.is_err());
    assert_eq!(
        account_b
            .apply_sync(complete(1, vec![plugin("beta", 2)]))
            .await
            .unwrap()["success"],
        true
    );
    let state = account_b.store.manifest.load().unwrap();
    assert!(state["plugins"].get("alpha@wework").is_none());
    assert_eq!(state["plugin_sync"]["complete_generation"], 1);
    assert!(state["plugin_sync"]["removals"].get("2").is_none());
    let account_a_again = CapabilitySyncHandler::with_package_provider(
        "test",
        account_b.store.clone(),
        Provider::default(),
    );
    assert!(account_b.apply_sync(complete(2, vec![])).await.is_err());
    assert!(account_a.apply_sync(complete(102, vec![])).await.is_err());
    assert_eq!(
        account_a_again
            .apply_sync(complete(101, vec![plugin("alpha", 1)]))
            .await
            .unwrap()["success"],
        true
    );
    assert!(account_a_again.store.manifest.load().unwrap()["plugins"]
        .get("beta@wework")
        .is_none());
}

struct HeldProvider {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl HeldProvider {
    async fn wait(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }
}

impl CapabilityPackageProvider for HeldProvider {
    fn stage_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            self.wait().await;
            fs::create_dir_all(target)?;
            fs::write(target.join("SKILL.md"), "Old account skill")?;
            Ok(())
        })
    }

    fn download_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            self.wait().await;
            let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
            archive
                .start_file("SKILL.md", zip::write::FileOptions::default())
                .unwrap();
            archive.write_all(b"Old account skill").unwrap();
            Ok(archive.finish().unwrap().into_inner())
        })
    }

    fn download_plugin<'a>(
        &'a self,
        _path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            self.wait().await;
            Ok(package("alpha"))
        })
    }
}

#[tokio::test]
async fn account_switch_during_download_prevents_old_publication() {
    for shared in [false, true] {
        for versioned in [false, true] {
            for skill in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let mut store = GlobalCapabilityStore::new(
                    root.path().join("capabilities/manifest.json"),
                    root.path().join(".claude/skills"),
                )
                .with_store_dir(root.path().join("store"));
                if shared {
                    store = store.with_workbench_root(root.path().join("workbench"));
                }
                let entered = Arc::new(Notify::new());
                let release = Arc::new(Notify::new());
                let account_a = CapabilitySyncHandler::with_package_provider(
                    "account-a",
                    store.clone(),
                    HeldProvider {
                        entered: entered.clone(),
                        release: release.clone(),
                    },
                );
                let mut payload = json!({"mode":"replace", "plugins":[], "skills":[], "mcps":[]});
                if skill {
                    payload["skills"] = json!([{"name":"old-account", "skill_id":1}]);
                } else {
                    payload["plugins"] = json!([plugin("alpha", 1)]);
                }
                if versioned {
                    payload["plugin_sync"] =
                        json!({"version":2, "generation":100, "complete":true});
                }
                let (result, (account_b, before)) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        tokio::join!(account_a.apply_sync(payload), async {
                            entered.notified().await;
                            let before = store.manifest.load().unwrap();
                            let account_b = CapabilitySyncHandler::with_package_provider(
                                "account-b",
                                store.clone(),
                                Provider::default(),
                            );
                            release.notify_one();
                            (account_b, before)
                        })
                    })
                    .await
                    .unwrap();
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("inactive backend connection"));
                assert_eq!(store.manifest.load().unwrap(), before);
                assert!(!store.skills_dir.join("old-account").exists());
                assert!(!store.codex_skills_dir.join("old-account").exists());
                assert!(!store
                    .plugin_runtime_link(&PluginSyncSpec::from_value(&plugin("alpha", 1)).unwrap())
                    .exists());
                assert!(!store
                    .plugin_codex_link(&PluginSyncSpec::from_value(&plugin("alpha", 1)).unwrap())
                    .exists());
                assert!(!store.plugins_dir.join("installed_plugins.json").exists());
                assert!(!store
                    .plugins_dir
                    .parent()
                    .unwrap()
                    .join("settings.json")
                    .exists());
                assert!(!store
                    .codex_plugins_dir
                    .parent()
                    .unwrap()
                    .join("config.toml")
                    .exists());
                assert_eq!(
                    account_b
                        .apply_sync(complete(1, vec![plugin("beta", 2)]))
                        .await
                        .unwrap()["success"],
                    true,
                );
                let current = store.manifest.load().unwrap();
                assert_eq!(current["plugin_sync"]["complete_generation"], 1);
                assert!(current["plugins"].get("alpha@wework").is_none());
                assert!(current["skills"].get("old-account").is_none());
            }
        }
    }
}
