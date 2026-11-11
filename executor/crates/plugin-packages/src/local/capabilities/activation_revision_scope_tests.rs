// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::capabilities::activation_revision::ActivationRevision;

fn partial(mut payload: Value, generation: u64) -> Value {
    payload["mode"] = json!("merge");
    if payload.get("plugin_sync").is_some() {
        payload["scope"] = json!("plugin_delta");
        payload["plugin_sync"]["complete"] = json!(false);
        next_generation(&mut payload, generation);
    } else {
        payload.as_object_mut().unwrap().remove("scope");
    }
    payload
}

async fn two_plugins(
    ordered: bool,
) -> (
    tempfile::TempDir,
    GlobalCapabilityStore,
    CapabilitySyncHandler<CountedPackages>,
    Value,
    Value,
) {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let provider = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        provider.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let first = plugin_payload(&provider, ordered, 1);
    sync(&handler, first.clone(), true, true).await;
    let mut second = partial(first.clone(), 2);
    second["plugins"][0]["marketplace"] = json!("wework");
    second["plugins"][0]["installed_plugin_id"] = json!(2);
    sync(&handler, second.clone(), true, true).await;
    (root, store, handler, partial(first, 3), second)
}

#[tokio::test]
async fn detection_skips_unrelated_runtime_and_reuses_unchanged_payload_hashes() {
    let (_root, store, _handler, payload, _) = two_plugins(true).await;
    let unrelated = store.manifest.load().unwrap()["plugins"]["demo@wework"]["runtime"]
        ["codex_link"]
        .as_str()
        .unwrap()
        .to_owned();
    let untouched = Path::new(&unrelated).join("large-unrelated.bin");
    fs::write(&untouched, vec![0; 2 * 1024 * 1024]).unwrap();
    let spec = PluginSyncSpec::from_value(&payload["plugins"][0]).unwrap();
    // Let freshly installed files leave the filesystem timestamp window
    // before checking that unchanged payload digests are reused.
    #[cfg(unix)]
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let _activation = crate::services::capability_activation::activate().await;
    let _publication = store.lock_shared_manifest().unwrap();
    let mut activation = ActivationRevision::begin(&store, &[spec], &[]).unwrap();
    // An external edit to another plugin is outside this operation's inspection scope.
    fs::write(&untouched, b"outside this operation").unwrap();
    let changes = activation.finish();
    assert!(!changes.changed);
    assert_eq!(changes.inspected_plugins, 1);
    assert!(changes.hashed_bytes < 2 * 1024 * 1024);
    assert!(changes.hashed_files > 0);
    #[cfg(unix)]
    assert_eq!(changes.reused_hashes, changes.hashed_files);
}

#[tokio::test]
async fn dynamic_removal_keeps_the_original_shared_metadata_baseline() {
    let (_root, store, _, payload, _) = two_plugins(true).await;
    let spec = PluginSyncSpec::from_value(&payload["plugins"][0]).unwrap();
    let _activation = crate::services::capability_activation::activate().await;
    let _publication = store.lock_shared_manifest().unwrap();
    let mut activation = ActivationRevision::begin(&store, &[], &[]).unwrap();
    let config = store
        .codex_plugins_dir
        .parent()
        .unwrap()
        .join("config.toml");
    let mut value = fs::read_to_string(&config)
        .unwrap()
        .parse::<toml_edit::DocumentMut>()
        .unwrap();
    value["plugins"]["unrelated@wegent"]["enabled"] = toml_edit::value(false);
    fs::write(config, value.to_string()).unwrap();
    activation.observe_plugin(&spec).unwrap();
    let changes = activation.finish();
    assert!(changes.changed && changes.requires_restart);
    assert_eq!(changes.inspected_plugins, 1);
}

#[tokio::test]
async fn requested_version_change_observes_the_previous_runtime() {
    let (_root, store, _, payload, _) = two_plugins(true).await;
    let mut spec = PluginSyncSpec::from_value(&payload["plugins"][0]).unwrap();
    spec.version = "2.0".to_owned();
    let previous = codex_runtime(&store).join("payload.txt");
    let _activation = crate::services::capability_activation::activate().await;
    let _publication = store.lock_shared_manifest().unwrap();
    let mut activation = ActivationRevision::begin(&store, &[spec], &[]).unwrap();
    fs::write(previous, "changed old version").unwrap();
    let changes = activation.finish();
    assert!(changes.changed && changes.requires_restart);
    assert_eq!(changes.plugins, ["demo@wegent"]);
}

#[cfg(unix)]
#[tokio::test]
async fn partial_sync_does_not_inspect_an_unrelated_damaged_runtime() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    for ordered in [false, true] {
        let (_root, store, handler, payload, _) = two_plugins(ordered).await;
        let manifest = store.manifest.load().unwrap();
        let runtime = Path::new(
            manifest["plugins"]["demo@wework"]["runtime"]["codex_link"]
                .as_str()
                .unwrap(),
        );
        let unexpected = runtime.join("unexpected.pipe");
        let path = CString::new(unexpected.as_os_str().as_bytes()).unwrap();
        // SAFETY: The NUL-terminated fixture path remains valid for the syscall.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let result = sync(&handler, payload, true, false).await;
        assert_eq!(result["requires_restart"], false);
        assert!(unexpected.exists());
    }
}
