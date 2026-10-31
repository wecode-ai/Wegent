// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::tests::{archive, payload, store, Packages};
use super::*;
use crate::local::plugin_import::{
    link_plugin_release, read_plugin_cloud_links, LinkPluginReleaseRequest,
    ReadPluginCloudLinksRequest,
};

struct PersonalInstallation {
    _temporary: tempfile::TempDir,
    store: GlobalCapabilityStore,
    handler: CapabilitySyncHandler<Packages>,
}

impl PersonalInstallation {
    async fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let store = store(&temporary.path().join("home"), true);
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
        );
        let mut request = payload("demo");
        request["plugins"][0]["marketplace"] = json!("wework-personal");
        let result = handler.apply_sync(request).await.unwrap();
        assert_eq!(result["success"], true, "{result}");
        Self {
            _temporary: temporary,
            store,
            handler,
        }
    }

    fn source(&self) -> PathBuf {
        self.store.personal_marketplace_dir().join("plugins/demo")
    }

    fn replace_source_with_matching_directory(&self) {
        let runtime = self
            .store
            .codex_plugins_dir
            .join("cache/wework-personal/demo/1.0");
        remove_existing_path(&self.source()).unwrap();
        copy_dir_recursive(&runtime, &self.source()).unwrap();
        assert!(!self.source().is_symlink());
        assert!(same_runtime_contents(&runtime, &self.source()).unwrap());
    }

    fn link_source(&self, cloud_release_id: Option<i64>) {
        link_plugin_release(LinkPluginReleaseRequest {
            marketplace_path: self
                .store
                .personal_marketplace_dir()
                .to_string_lossy()
                .into_owned(),
            local_plugin_name: "demo".into(),
            cloud_plugin_id: 7,
            cloud_release_id,
        })
        .unwrap();
    }

    fn registry(&self) -> PathBuf {
        self.store
            .manifest
            .path
            .parent()
            .unwrap()
            .join("plugin-state/wework-personal-cloud-links.json")
    }

    fn assert_registry_read_fails(&self) {
        assert!(read_plugin_cloud_links(ReadPluginCloudLinksRequest {
            marketplace_path: self
                .store
                .personal_marketplace_dir()
                .to_string_lossy()
                .into_owned(),
        })
        .is_err());
    }

    async fn uninstall_account(&self) {
        let result = self
            .handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap();
        assert_eq!(result["success"], true, "{result}");
        assert!(self.store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn account_uninstall_preserves_identical_published_author_source_and_link() {
    for release in [None, Some(8)] {
        let installation = PersonalInstallation::new().await;
        installation.replace_source_with_matching_directory();
        installation.link_source(release);
        let original_registry = fs::read(installation.registry()).unwrap();
        let manifest = installation.source().join(".codex-plugin/plugin.json");
        let original_manifest = fs::read(&manifest).unwrap();
        let marketplace_manifests = installation
            .handler
            .personal_shared_marketplace_manifest_paths()
            .into_iter()
            .map(|path| {
                let contents = fs::read(&path).ok();
                (path, contents)
            })
            .collect::<Vec<_>>();
        assert!(marketplace_manifests.iter().any(|(_, data)| data.is_some()));

        installation.uninstall_account().await;

        assert!(installation.source().is_dir());
        assert_eq!(fs::read(manifest).unwrap(), original_manifest);
        assert_eq!(
            fs::read(installation.source().join("skills/demo/SKILL.md")).unwrap(),
            b"plugin capability"
        );
        assert_eq!(
            fs::read(installation.registry()).unwrap(),
            original_registry
        );
        for (path, contents) in marketplace_manifests {
            assert_eq!(fs::read(path).ok(), contents);
        }
    }
}

#[tokio::test]
async fn account_uninstall_preserves_modified_published_author_source() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    fs::write(
        installation.source().join("author.txt"),
        "unpublished changes",
    )
    .unwrap();

    installation.uninstall_account().await;

    assert_eq!(
        fs::read_to_string(installation.source().join("author.txt")).unwrap(),
        "unpublished changes"
    );
}

#[tokio::test]
async fn cloud_update_cannot_reclaim_an_identical_published_author_directory() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    let source_manifest = installation.source().join(".codex-plugin/plugin.json");
    let original_source_manifest = fs::read(&source_manifest).unwrap();
    let original_registry = fs::read(installation.registry()).unwrap();
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    request["plugins"][0]["version"] = json!("2.0");

    let result = installation.handler.apply_sync(request).await.unwrap();

    assert_eq!(result["success"], false, "{result}");
    assert!(result
        .to_string()
        .contains("Plugin marketplace entry is occupied by an unrelated source"));
    assert!(!installation.source().is_symlink());
    assert_eq!(
        fs::read(&source_manifest).unwrap(),
        original_source_manifest
    );
    assert_eq!(
        fs::read(installation.registry()).unwrap(),
        original_registry
    );

    installation.uninstall_account().await;

    assert!(!installation.source().is_symlink());
    assert_eq!(fs::read(source_manifest).unwrap(), original_source_manifest);
    assert_eq!(
        fs::read(installation.registry()).unwrap(),
        original_registry
    );
}

#[tokio::test]
async fn account_uninstall_removes_unlinked_managed_directory_copy() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    assert!(read_plugin_cloud_links(ReadPluginCloudLinksRequest {
        marketplace_path: installation
            .store
            .personal_marketplace_dir()
            .to_string_lossy()
            .into_owned(),
    })
    .unwrap()
    .is_empty());

    installation.uninstall_account().await;

    assert!(!installation.source().exists());
}

#[tokio::test]
async fn unrelated_published_source_does_not_protect_a_managed_directory_copy() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    fs::write(
        installation.registry(),
        serde_json::to_vec(&json!({"cloudLinks":[{
            "localPluginName":"another-plugin", "cloudPluginId":71, "cloudReleaseId":82
        }]}))
        .unwrap(),
    )
    .unwrap();

    installation.uninstall_account().await;

    assert!(!installation.source().exists());
}

#[tokio::test]
async fn account_uninstall_preserves_directory_when_source_registry_is_invalid() {
    for contents in [
        "invalid-json",
        "{}",
        "{\"cloud_links\":[]}",
        "{\"cloudLinks\":[{\"localPluginName\":\"demo\",\"cloudPluginId\":\"invalid\"}]}",
    ] {
        let installation = PersonalInstallation::new().await;
        installation.replace_source_with_matching_directory();
        installation.link_source(Some(8));
        fs::write(installation.registry(), contents).unwrap();
        installation.assert_registry_read_fails();

        installation.uninstall_account().await;

        assert!(installation.source().is_dir());
        assert_eq!(
            fs::read_to_string(installation.registry()).unwrap(),
            contents
        );
    }
}

#[tokio::test]
async fn account_uninstall_preserves_directory_when_source_registry_is_unreadable() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    fs::remove_file(installation.registry()).unwrap();
    fs::create_dir(installation.registry()).unwrap();
    installation.assert_registry_read_fails();

    installation.uninstall_account().await;

    assert!(installation.source().is_dir());
    assert!(installation.registry().is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn stale_published_link_does_not_protect_an_owned_managed_symlink() {
    for invalid_registry in [false, true] {
        let installation = PersonalInstallation::new().await;
        assert!(installation.source().is_symlink());
        installation.link_source(Some(8));
        if invalid_registry {
            fs::write(installation.registry(), "invalid-json").unwrap();
        }

        installation.uninstall_account().await;

        assert!(!installation.source().exists());
        assert!(!installation.source().is_symlink());
    }
}
