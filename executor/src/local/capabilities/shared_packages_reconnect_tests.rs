// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{
    tests::{packages, store},
    *,
};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn reconnect_reuses_verified_plugin_and_changed_checksum_downloads() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let first = packages("v1");
    let mut payload = json!({"scope":"plugins", "plugins":[{"name":"demo", "installed_plugin_id":1,
        "marketplace":"wegent", "version":"1.0", "download_path":"/package",
        "checksum":sha256_digest(&first.plugin)}]});
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), first.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    assert_eq!(first.plugin_downloads.load(Ordering::SeqCst), 1);

    // A new connection has a new handler and signed URL, but the same package.
    payload["plugins"][0]["download_path"] = json!("/package?renewed-signature");
    let reconnected =
        CapabilitySyncHandler::with_package_provider("", store.clone(), first.clone());
    assert_eq!(
        reconnected.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    assert_eq!(first.plugin_downloads.load(Ordering::SeqCst), 1);

    let second = packages("v2");
    payload["plugins"][0]["checksum"] = json!(sha256_digest(&second.plugin));
    let updated = CapabilitySyncHandler::with_package_provider("", store.clone(), second.clone());
    assert_eq!(updated.apply_sync(payload).await.unwrap()["success"], true);
    assert_eq!(second.plugin_downloads.load(Ordering::SeqCst), 1);
    let manifest = store.manifest.load().unwrap();
    let native = PathBuf::from(
        manifest["plugins"]["demo@wegent"]["runtime"]["codex_link"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(
        fs::read_to_string(native.join("payload.txt")).unwrap(),
        "v2"
    );
}

#[tokio::test]
async fn missing_or_legacy_shared_plugin_is_downloaded_again() {
    for legacy in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let payload = json!({"scope":"plugins", "plugins":[{"name":"demo", "installed_plugin_id":1,
            "marketplace":"wegent", "version":"1.0", "download_path":"/package",
            "checksum":sha256_digest(&packages.plugin)}]});
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        assert_eq!(
            handler.apply_sync(payload.clone()).await.unwrap()["success"],
            true
        );
        let mut manifest = store.manifest.load().unwrap();
        let shared = PathBuf::from(
            manifest["plugins"]["demo@wegent"]["store_path"]
                .as_str()
                .unwrap(),
        );
        if legacy {
            let legacy_path = root.path().join("legacy-plugin");
            fs::rename(&shared, &legacy_path).unwrap();
            manifest["plugins"]["demo@wegent"]["store_path"] = json!(legacy_path);
            store.manifest.save(manifest).unwrap();
        } else {
            fs::remove_dir_all(&shared).unwrap();
        }

        let reconnected =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        assert_eq!(
            reconnected.apply_sync(payload).await.unwrap()["success"],
            true
        );
        assert_eq!(packages.plugin_downloads.load(Ordering::SeqCst), 2);
        assert_eq!(
            fs::read_to_string(shared.join("payload.txt")).unwrap(),
            "v1"
        );
    }
}

#[tokio::test]
async fn reconnect_rejects_corrupted_shared_plugin_without_redownloading() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let payload = json!({"scope":"plugins", "plugins":[{"name":"demo", "installed_plugin_id":1,
        "marketplace":"wegent", "version":"1.0", "download_path":"/package",
        "checksum":sha256_digest(&packages.plugin)}]});
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    assert_eq!(
        handler.apply_sync(payload.clone()).await.unwrap()["success"],
        true
    );
    let before = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let shared = PathBuf::from(before["store_path"].as_str().unwrap());
    fs::remove_file(shared.join("payload.txt")).unwrap();

    let reconnected =
        CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let result = reconnected.apply_sync(payload).await.unwrap();
    assert_eq!(result["success"], false);
    assert_eq!(packages.plugin_downloads.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"],
        before
    );
}
