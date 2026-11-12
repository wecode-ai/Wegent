// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::{mpsc, Semaphore};

#[path = "coalescing_tests.rs"]
mod coalescing_tests;

struct GatedPackages {
    entered: mpsc::UnboundedSender<String>,
    gates: BTreeMap<String, Arc<Semaphore>>,
    active: AtomicUsize,
    maximum: AtomicUsize,
    calls: AtomicUsize,
    fail: AtomicBool,
}

struct Download<'a>(&'a AtomicUsize);
impl Drop for Download<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl CapabilityPackageProvider for GatedPackages {
    fn stage_skill<'a>(
        &'a self,
        _: &'a SkillSyncSpec,
        _: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { panic!("No standalone skills") })
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            let _download = Download(&self.active);
            self.maximum.fetch_max(active, Ordering::SeqCst);
            self.entered.send(path.to_owned()).unwrap();
            if let Some(gate) = self.gates.get(path) {
                gate.acquire().await.unwrap().forget();
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(invalid("Injected download failure"));
            }
            if path.ends_with("/corrupt") {
                return Ok(b"corrupt archive bytes".to_vec());
            }
            let (name, variant) = path.trim_start_matches('/').split_once('/').unwrap();
            Ok(variant_package(name, variant))
        })
    }
}

fn variant_package(name: &str, variant: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new_append(Cursor::new(package(name))).unwrap();
    archive
        .start_file("variant.txt", zip::write::FileOptions::default())
        .unwrap();
    archive.write_all(variant.as_bytes()).unwrap();
    archive.finish().unwrap().into_inner()
}

fn desired(name: &str, variant: &str) -> Value {
    let mut spec = plugin(
        name,
        if name == "alpha" {
            1
        } else if name == "beta" {
            2
        } else {
            3
        },
    );
    spec["checksum"] = json!(sha256_digest(&variant_package(name, variant)));
    spec["download_path"] = json!(format!("/{name}/{variant}"));
    spec
}

fn gated_fixture(
    shared: bool,
    blocked: &[&str],
) -> (
    tempfile::TempDir,
    Arc<CapabilitySyncHandler<GatedPackages>>,
    mpsc::UnboundedReceiver<String>,
) {
    let root = tempfile::tempdir().unwrap();
    let mut store = GlobalCapabilityStore::new(
        root.path().join("state/manifest.json"),
        root.path().join("claude/skills"),
    )
    .with_store_dir(root.path().join("store"))
    .with_plugins_dir(root.path().join("claude/plugins"))
    .with_codex_plugins_dir(root.path().join("codex/plugins"));
    if shared {
        store = store.with_workbench_root(root.path().join("workbench"));
    }
    let (entered, receiver) = mpsc::unbounded_channel();
    let provider = GatedPackages {
        entered,
        gates: blocked
            .iter()
            .map(|path| ((*path).to_owned(), Arc::new(Semaphore::new(0))))
            .collect(),
        active: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
        fail: AtomicBool::new(false),
    };
    (
        root,
        Arc::new(CapabilitySyncHandler::with_package_provider(
            "test",
            store,
            provider,
            std::sync::Arc::new(crate::NoRunningSessions),
        )),
        receiver,
    )
}

async fn until_manifest(
    handler: &CapabilitySyncHandler<GatedPackages>,
    test: impl Fn(&Value) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if test(&handler.store.manifest.load().unwrap()) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The expected publication or ordering fence was not reached");
}

async fn next_download(receiver: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("The expected independent preparation did not start")
        .expect("Package provider closed before the expected preparation")
}

fn start(
    handler: &Arc<CapabilitySyncHandler<GatedPackages>>,
    payload: Value,
) -> tokio::task::JoinHandle<Result<Value, CapabilitySyncError>> {
    let handler = handler.clone();
    tokio::spawn(async move { handler.apply_sync(payload).await })
}

async fn completed(task: tokio::task::JoinHandle<Result<Value, CapabilitySyncError>>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn independent_install_publishes_while_another_download_is_blocked() {
    for shared in [false, true] {
        let (_root, handler, mut entered) = gated_fixture(shared, &["/alpha/old"]);
        let slow = start(&handler, delta(10, vec![desired("alpha", "old")], vec![]));
        assert_eq!(next_download(&mut entered).await, "/alpha/old");
        // Preparation does not prevent a new native session from reading the
        // currently published capabilities while an unrelated network call waits.
        let reader = tokio::time::timeout(
            Duration::from_secs(5),
            crate::services::capability_activation::begin_execution(),
        )
        .await
        .unwrap();
        drop(reader);
        let fast = completed(start(
            &handler,
            delta(11, vec![desired("beta", "new")], vec![]),
        ))
        .await;
        assert_eq!(fast["success"], true);
        let manifest = handler.store.manifest.load().unwrap();
        assert!(manifest["plugins"].get("alpha@wework").is_none());
        assert_eq!(
            manifest["plugins"]["beta@wework"]["checksum"],
            desired("beta", "new")["checksum"]
        );
        handler.package_provider.gates["/alpha/old"].add_permits(1);
        assert_eq!(completed(slow).await["success"], true);
        let manifest = handler.store.manifest.load().unwrap();
        assert_eq!(manifest["plugins"].as_object().unwrap().len(), 2);
        // Fresh metadata writers merge both commits instead of publishing two
        // independent snapshots of the same marketplace/configuration files.
        let catalog = handler
            .store
            .codex_marketplace_dir("wework")
            .join(".agents/plugins/marketplace.json");
        let catalog: Value = serde_json::from_slice(&fs::read(catalog).unwrap()).unwrap();
        assert_eq!(catalog["plugins"].as_array().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn one_batch_publishes_ready_plugins_without_waiting_for_the_slowest() {
    let (_root, handler, mut entered) = gated_fixture(true, &["/alpha/old"]);
    let batch = start(
        &handler,
        complete(10, vec![desired("alpha", "old"), desired("beta", "new")]),
    );
    let mut names = vec![
        next_download(&mut entered).await,
        next_download(&mut entered).await,
    ];
    names.sort();
    assert_eq!(names, vec!["/alpha/old", "/beta/new"]);
    until_manifest(&handler, |manifest| {
        manifest["plugins"].get("beta@wework").is_some()
    })
    .await;
    assert!(!batch.is_finished());
    handler.package_provider.gates["/alpha/old"].add_permits(1);
    assert_eq!(completed(batch).await["success"], true);
}

#[tokio::test]
async fn preparation_limit_is_shared_across_batches_and_reconnected_handlers() {
    let (_root, handler, mut entered) =
        gated_fixture(true, &["/alpha/one", "/beta/one", "/gamma/one"]);
    let first = start(&handler, delta(10, vec![desired("alpha", "one")], vec![]));
    next_download(&mut entered).await;
    let second = start(&handler, delta(11, vec![desired("beta", "one")], vec![]));
    next_download(&mut entered).await;
    let third = start(&handler, delta(12, vec![desired("gamma", "one")], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["gamma@wework"]["generation"] == 12
    })
    .await;
    assert_eq!(handler.package_provider.active.load(Ordering::SeqCst), 2);
    assert_eq!(handler.plugin_preparation.slots.available_permits(), 0);
    assert!(entered.try_recv().is_err());
    handler.package_provider.gates["/alpha/one"].add_permits(1);
    assert_eq!(completed(first).await["success"], true);
    assert_eq!(next_download(&mut entered).await, "/gamma/one");
    handler.package_provider.gates["/beta/one"].add_permits(1);
    handler.package_provider.gates["/gamma/one"].add_permits(1);
    assert_eq!(completed(second).await["success"], true);
    assert_eq!(completed(third).await["success"], true);
    assert_eq!(handler.package_provider.maximum.load(Ordering::SeqCst), 2);
    let new_handler = CapabilitySyncHandler::with_package_provider(
        "new-account",
        handler.store.clone(),
        Provider::default(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert!(Arc::ptr_eq(
        &handler.plugin_preparation,
        &new_handler.plugin_preparation
    ));
}

#[tokio::test]
async fn same_plugin_prepares_in_order_without_starving_another_plugin() {
    let (_root, handler, mut entered) = gated_fixture(true, &["/alpha/old", "/alpha/new"]);
    let old = start(&handler, delta(10, vec![desired("alpha", "old")], vec![]));
    assert_eq!(next_download(&mut entered).await, "/alpha/old");
    let newer = start(&handler, delta(11, vec![desired("alpha", "new")], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 11
    })
    .await;
    assert!(entered.try_recv().is_err());
    assert_eq!(
        completed(start(
            &handler,
            delta(12, vec![desired("beta", "new")], vec![])
        ))
        .await["success"],
        true
    );
    assert_eq!(next_download(&mut entered).await, "/beta/new");
    handler.package_provider.gates["/alpha/old"].add_permits(1);
    assert_eq!(completed(old).await["plugins"][0]["status"], "superseded");
    assert_eq!(next_download(&mut entered).await, "/alpha/new");
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
    handler.package_provider.gates["/alpha/new"].add_permits(1);
    assert_eq!(completed(newer).await["success"], true);
    let manifest = handler.store.manifest.load().unwrap();
    assert_eq!(
        manifest["plugins"]["alpha@wework"]["checksum"],
        desired("alpha", "new")["checksum"]
    );
    assert_eq!(manifest["plugins"].as_object().unwrap().len(), 2);
}

#[tokio::test]
async fn uninstall_accepted_during_preparation_prevents_old_install_publication() {
    for shared in [false, true] {
        let (_root, handler, mut entered) = gated_fixture(shared, &["/alpha/old"]);
        let spec = desired("alpha", "old");
        let install = start(&handler, delta(10, vec![spec.clone()], vec![]));
        next_download(&mut entered).await;
        let removal = start(&handler, delta(11, vec![], vec![spec.clone()]));
        until_manifest(&handler, |manifest| {
            manifest["plugin_sync"]["removals"]["1"]["generation"] == 11
        })
        .await;
        handler.package_provider.gates["/alpha/old"].add_permits(1);
        assert_eq!(
            completed(install).await["plugins"][0]["status"],
            "superseded"
        );
        assert_eq!(completed(removal).await["plugins"][0]["status"], "removed");
        let manifest = handler.store.manifest.load().unwrap();
        assert!(manifest["plugins"].get("alpha@wework").is_none());
        assert_eq!(manifest["plugin_sync"]["removals"]["1"]["pending"], false);
        let spec = PluginSyncSpec::from_value(&spec).unwrap();
        assert!(!handler.store.plugin_codex_link(&spec).exists());
        assert!(!handler.store.plugin_runtime_link(&spec).exists());
    }
}

#[tokio::test]
async fn newest_reinstall_survives_both_old_install_and_queued_uninstall() {
    let (_root, handler, mut entered) = gated_fixture(true, &["/alpha/old"]);
    let install = start(&handler, delta(10, vec![desired("alpha", "old")], vec![]));
    next_download(&mut entered).await;
    let removal = start(&handler, delta(11, vec![], vec![desired("alpha", "old")]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["removals"]["1"]["generation"] == 11
    })
    .await;
    let reinstall = start(&handler, delta(12, vec![desired("alpha", "new")], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 12
    })
    .await;
    handler.package_provider.gates["/alpha/old"].add_permits(1);
    assert_eq!(
        completed(install).await["plugins"][0]["status"],
        "superseded"
    );
    assert_eq!(
        completed(removal).await["plugins"][0]["status"],
        "superseded"
    );
    assert_eq!(completed(reinstall).await["plugins"][0]["status"], "synced");
    let manifest = handler.store.manifest.load().unwrap();
    assert_eq!(
        manifest["plugins"]["alpha@wework"]["checksum"],
        desired("alpha", "new")["checksum"]
    );
}

#[tokio::test]
async fn failed_publication_removes_new_runtime_paths_and_same_generation_retry_succeeds() {
    for shared in [false, true] {
        let (_root, handler, _entered) = gated_fixture(shared, &[]);
        let spec = desired("alpha", "new");
        let parsed = PluginSyncSpec::from_value(&spec).unwrap();
        let config = handler
            .store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, "[invalid").unwrap();
        let failed = handler
            .apply_sync(delta(10, vec![spec.clone()], vec![]))
            .await
            .unwrap();
        assert_eq!(failed["plugins"][0]["status"], "failed");
        assert!(handler.store.manifest.load().unwrap()["plugins"]
            .get(&parsed.key)
            .is_none());
        for path in handler.store.runtime_state_paths(&parsed).1 {
            assert!(
                !path.exists() && !path.is_symlink(),
                "Failed publication retained {}",
                path.display()
            );
        }
        assert_eq!(fs::read_to_string(&config).unwrap(), "[invalid");
        fs::remove_file(config).unwrap();
        let retry = handler
            .apply_sync(delta(10, vec![spec], vec![]))
            .await
            .unwrap();
        assert_eq!(retry["plugins"][0]["status"], "synced");
    }
}

#[tokio::test]
async fn corrupt_package_does_not_block_another_plugin_or_change_its_metadata() {
    let (_root, handler, _entered) = gated_fixture(true, &[]);
    let result = handler
        .apply_sync(complete(
            10,
            vec![desired("alpha", "corrupt"), desired("beta", "new")],
        ))
        .await
        .unwrap();
    assert_eq!(result["success"], false);
    assert_eq!(result["plugins"][0]["status"], "failed");
    assert_eq!(
        result["plugins"][0]["error_code"],
        "PLUGIN_PACKAGE_INTEGRITY_FAILED"
    );
    assert_eq!(result["plugins"][1]["status"], "synced");
    let manifest = handler.store.manifest.load().unwrap();
    assert!(manifest["plugins"].get("alpha@wework").is_none());
    assert_eq!(
        manifest["plugins"]["beta@wework"]["checksum"],
        desired("beta", "new")["checksum"]
    );
}

#[tokio::test]
async fn cancelled_download_releases_its_lane_and_slot_for_same_generation_retry() {
    let (_root, handler, mut entered) = gated_fixture(true, &["/alpha/old"]);
    let payload = delta(10, vec![desired("alpha", "old")], vec![]);
    let cancelled = start(&handler, payload.clone());
    assert_eq!(next_download(&mut entered).await, "/alpha/old");
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(
        handler.plugin_preparation.slots.available_permits(),
        plugin_preparation::MAX_PLUGIN_PREPARATIONS
    );
    assert_eq!(handler.package_provider.active.load(Ordering::SeqCst), 0);
    let retry = start(&handler, payload);
    assert_eq!(next_download(&mut entered).await, "/alpha/old");
    handler.package_provider.gates["/alpha/old"].add_permits(1);
    assert_eq!(completed(retry).await["plugins"][0]["status"], "synced");
}

#[tokio::test]
async fn legacy_full_cleanup_cannot_be_overtaken_by_a_preparing_versioned_install() {
    let (_root, handler, mut entered) = gated_fixture(true, &["/alpha/old"]);
    let install = start(&handler, delta(10, vec![desired("alpha", "old")], vec![]));
    assert_eq!(next_download(&mut entered).await, "/alpha/old");
    assert!(handler.plugin_preparation.protocol.try_write().is_err());
    let cleanup = start(&handler, json!({"scope":"plugins", "plugins":[]}));
    handler.package_provider.gates["/alpha/old"].add_permits(1);
    assert_eq!(completed(install).await["plugins"][0]["status"], "synced");
    assert_eq!(completed(cleanup).await["success"], true);
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
}
