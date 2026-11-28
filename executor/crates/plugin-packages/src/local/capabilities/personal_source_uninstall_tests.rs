// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::tests::{archive, payload, store, Packages};
use super::*;
use crate::local::plugin_import::{
    link_plugin_release, read_plugin_cloud_links, LinkPluginReleaseRequest, PluginAccountScope,
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
        let store = store(&temporary.path().join("home"), true).with_account_scope(account_scope());
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
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
            account_install: None,
            account_scope: Some(account_scope()),
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

fn account_scope() -> PluginAccountScope {
    PluginAccountScope::new("https://plugins.example", 1).unwrap()
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
async fn ordinary_cloud_runtime_clears_stale_author_source_metadata() {
    let installation = PersonalInstallation::new().await;
    let mut manifest = installation.store.manifest.load().unwrap();
    let key = "demo@wework-personal";
    manifest["plugins"][key]["materialization"] = json!("author_source");
    manifest["plugins"][key]["author_source"] = json!({"installed":false,"enabled":false});
    let entry = &manifest["plugins"][key];
    let spec = checked_spec(key, entry).unwrap();
    let package = PathBuf::from(entry["store_path"].as_str().unwrap());

    installation
        .store
        .install_plugin_runtime_metadata(&spec, &package, &mut manifest)
        .unwrap();

    let entry = &manifest["plugins"][key];
    assert!(entry.get("materialization").is_none());
    assert!(entry.get("author_source").is_none());
    assert!(Path::new(entry["runtime"]["codex_link"].as_str().unwrap()).is_dir());
    installation.store.manifest.save(manifest).unwrap();
    let recovered = installation
        .store
        .reconcile_managed_plugin_runtimes()
        .unwrap();
    assert!(recovered.failed.is_empty(), "{recovered:?}");
}

#[tokio::test]
async fn owner_account_sync_preserves_the_independently_installed_author_version() {
    for versioned in [false, true] {
        let installation = PersonalInstallation::new().await;
        installation.replace_source_with_matching_directory();
        installation.link_source(Some(8));
        let source_manifest = installation.source().join(".codex-plugin/plugin.json");
        fs::write(&source_manifest, r#"{"name":"demo","version":"1.1"}"#).unwrap();
        fs::write(
            installation.source().join("author.txt"),
            "unpublished changes",
        )
        .unwrap();
        let codex_home = installation.store.codex_plugins_dir.parent().unwrap();
        let runtime = codex_home.join("plugins/cache/wework-personal/demo/1.1");
        copy_dir_recursive(&installation.source(), &runtime).unwrap();
        let config = codex_home.join("config.toml");
        fs::write(&config, "[plugins.'demo@wework-personal']\nenabled=true\n").unwrap();
        let original_config = fs::read(&config).unwrap();
        let original_source = tree_fingerprint(&installation.source()).unwrap();
        let original_runtime = tree_fingerprint(&runtime).unwrap();
        let original_registry = fs::read(installation.registry()).unwrap();
        let metadata: Vec<_> = installation
            .handler
            .personal_shared_marketplace_manifest_paths()
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).ok();
                (path, bytes)
            })
            .collect();
        let mut request = payload("demo");
        request["plugins"][0]["marketplace"] = json!("wework-personal");
        request["plugins"][0]["personal_source_owner"] = json!(true);
        if versioned {
            request["plugin_sync"] = json!({"version":2,"generation":1,"complete":true});
        }

        let result = installation.handler.apply_sync(request).await.unwrap();

        assert_eq!(result["success"], true, "{result}");
        assert_eq!(result["changed"], false, "{result}");
        assert_eq!(result["plugins"][0]["status"], "source_preserved");
        assert_eq!(
            result["plugins"][0]["source"],
            json!({"installed":true,"enabled":true,"version":"1.1"})
        );
        assert_eq!(result["plugins"][0]["version"], "1.0");
        assert!(result["plugins"][0]["checksum"].is_string());
        let manifest = installation.store.manifest.load().unwrap();
        let entry = &manifest["plugins"]["demo@wework-personal"];
        assert_eq!(entry["materialization"], "author_source");
        assert_eq!(entry["version"], "1.0");
        assert_eq!(entry["cloud_plugin_id"], 7);
        assert_eq!(entry["installed_plugin_id"], 41);
        assert_eq!(
            entry["author_source"]["runtime_path"],
            json!(runtime.canonicalize().unwrap())
        );
        assert!(entry.get("runtime").is_none());
        assert!(Path::new(entry["store_path"].as_str().unwrap()).is_dir());
        assert!(installation.handler.local_plugin_digest().is_ok());
        let offline = store(&installation._temporary.path().join("home"), true);
        let offline_digest = activation_revision::local_plugin_digest(&offline).unwrap();
        assert_eq!(
            offline_digest,
            installation.handler.local_plugin_digest().unwrap()
        );
        let offline_spec = PluginSyncSpec::from_manifest_entry("demo@wework-personal", entry);
        let mut observer =
            activation_revision::ActivationRevision::begin(&offline, &[offline_spec], &[]).unwrap();
        assert!(!observer.finish().changed);
        drop(observer);
        let offline_recovery = offline.reconcile_managed_plugin_runtimes().unwrap();
        assert!(offline_recovery.failed.is_empty(), "{offline_recovery:?}");
        let report = installation
            .store
            .reconcile_managed_plugin_runtimes()
            .unwrap();
        assert!(report.failed.is_empty(), "{report:?}");
        let reported = GlobalCapabilityReporter::new(
            &installation.store.skills_dir,
            &installation.store.plugins_dir,
            installation.store.manifest.clone(),
        )
        .build_report(true)
        .unwrap();
        assert_eq!(reported["plugins"][0]["version"], "1.1");
        assert_eq!(reported["plugins"][0]["materialization"], "author_source");
        assert_eq!(reported["plugins"][0]["author_source"]["enabled"], true);

        installation.uninstall_account().await;

        assert_eq!(fs::read(&config).unwrap(), original_config);
        assert_eq!(
            tree_fingerprint(&installation.source()).unwrap(),
            original_source
        );
        assert_eq!(tree_fingerprint(&runtime).unwrap(), original_runtime);
        assert_eq!(
            fs::read(installation.registry()).unwrap(),
            original_registry
        );
        for (path, bytes) in metadata {
            assert_eq!(fs::read(path).ok(), bytes);
        }
    }
}

#[tokio::test]
async fn author_preservation_requires_a_matching_cloud_identity() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    let before = tree_fingerprint(&installation.source()).unwrap();
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    request["plugins"][0]["personal_source_owner"] = json!(true);
    request["plugins"][0]["cloud_plugin_id"] = json!(99);

    let result = installation.handler.apply_sync(request).await.unwrap();

    assert_eq!(result["success"], false, "{result}");
    assert!(result
        .to_string()
        .contains("Plugin marketplace entry is occupied by an unrelated source"));
    assert_eq!(tree_fingerprint(&installation.source()).unwrap(), before);
    assert_ne!(
        installation.store.manifest.load().unwrap()["plugins"]["demo@wework-personal"]
            ["materialization"],
        "author_source"
    );
}

#[tokio::test]
async fn author_source_scope_cannot_be_inferred_from_colliding_backend_ids() {
    for legacy in [false, true] {
        let installation = PersonalInstallation::new().await;
        installation.replace_source_with_matching_directory();
        installation.link_source(Some(8));
        if legacy {
            let path = installation.registry();
            let mut registry: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            registry["cloudLinks"][0]
                .as_object_mut()
                .unwrap()
                .remove("accountScope");
            fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
        }
        let before = tree_fingerprint(&installation.source()).unwrap();
        let scope = if legacy {
            account_scope()
        } else {
            PluginAccountScope::new("https://other-backend.example", 1).unwrap()
        };
        let scoped_store =
            store(&installation._temporary.path().join("home"), true).with_account_scope(scope);
        let handler = CapabilitySyncHandler::with_package_provider(
            "other-session",
            scoped_store,
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut request = payload("demo");
        request["plugins"][0]["marketplace"] = json!("wework-personal");
        request["plugins"][0]["personal_source_owner"] = json!(true);

        let result = handler.apply_sync(request).await.unwrap();

        assert_eq!(result["success"], false, "{result}");
        assert!(result
            .to_string()
            .contains("Plugin marketplace entry is occupied by an unrelated source"));
        assert_eq!(tree_fingerprint(&installation.source()).unwrap(), before);
    }
}

#[tokio::test]
async fn authoritative_account_probe_can_initialize_an_unbound_handler_scope() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    let handler = CapabilitySyncHandler::with_package_provider(
        "http-session",
        store(&installation._temporary.path().join("home"), true),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    request["plugins"][0]["personal_source_owner"] = json!(true);
    let unbound = handler.apply_sync(request.clone()).await.unwrap();
    assert_eq!(unbound["success"], false);

    handler
        .bind_account_scope("https://plugins.example/", 1)
        .unwrap();
    let bound = handler.apply_sync(request).await.unwrap();

    assert_eq!(bound["success"], true, "{bound}");
    assert_eq!(bound["plugins"][0]["status"], "source_preserved");
    assert!(handler
        .bind_account_scope("https://other.example", 1)
        .is_err());
}

#[tokio::test]
async fn identical_tokens_do_not_share_author_receipts_between_backends() {
    let installation = PersonalInstallation::new().await;
    installation.replace_source_with_matching_directory();
    installation.link_source(Some(8));
    let root = installation._temporary.path().join("home");
    let scope_b = PluginAccountScope::new("https://other-backend.example", 1).unwrap();
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    request["plugins"][0]["personal_source_owner"] = json!(true);
    request["plugin_sync"] = json!({"version":2,"generation":100,"complete":true});
    let first = CapabilitySyncHandler::with_package_provider(
        "same-token",
        store(&root, true).with_account_scope(account_scope()),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        first.apply_sync(request.clone()).await.unwrap()["plugins"][0]["status"],
        "source_preserved"
    );
    link_plugin_release(LinkPluginReleaseRequest {
        marketplace_path: installation
            .store
            .personal_marketplace_dir()
            .to_string_lossy()
            .into_owned(),
        local_plugin_name: "demo".into(),
        cloud_plugin_id: 7,
        cloud_release_id: Some(9),
        account_install: Some(crate::local::plugin_import::AccountInstallLinkMode::KeepRelease),
        account_scope: Some(scope_b.clone()),
    })
    .unwrap();
    let second_store = store(&root, true).with_account_scope(scope_b.clone());
    let second = CapabilitySyncHandler::with_package_provider(
        "same-token",
        second_store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    request["plugin_sync"]["generation"] = json!(1);

    let result = second.apply_sync(request).await.unwrap();

    assert_eq!(result["success"], true, "{result}");
    assert_eq!(result["plugins"][0]["status"], "source_preserved");
    let manifest = second_store.manifest.load().unwrap();
    assert_eq!(
        manifest["plugins"]["demo@wework-personal"]["account_scope"],
        json!(scope_b)
    );
    assert_eq!(manifest["plugin_sync"]["complete_generation"], 1);
}

#[tokio::test]
async fn owner_source_receipts_preserve_disabled_and_uninstalled_native_facts() {
    for installed in [false, true] {
        let installation = PersonalInstallation::new().await;
        installation.replace_source_with_matching_directory();
        installation.link_source(Some(8));
        let config = installation
            .store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        if !installed {
            fs::write(&config, "").unwrap();
        }
        let original = fs::read(&config).unwrap();
        let mut request = payload("demo");
        request["plugins"][0]["marketplace"] = json!("wework-personal");
        request["plugins"][0]["personal_source_owner"] = json!(true);
        request["plugin_sync"] = json!({"version":2,"generation":1,"complete":true});

        let result = installation.handler.apply_sync(request).await.unwrap();

        assert_eq!(result["success"], true, "{result}");
        assert_eq!(result["plugins"][0]["status"], "source_preserved");
        let source = &result["plugins"][0]["source"];
        assert_eq!(source["installed"], installed);
        assert_eq!(source["enabled"], false);
        assert_eq!(source.get("version").is_some(), installed);
        assert_eq!(fs::read(config).unwrap(), original);
    }
}

#[test]
fn personal_manifest_display_names_require_the_platform_slug_identity() {
    assert!(author_source::personal_manifest_name_matches_slug(
        "Desktop E2E Personal Version",
        "desktop-e2e-personal-version"
    ));
    for name in [
        "other-plugin",
        "../desktop-e2e-personal-version",
        "desktop/e2e-personal-version",
        "desktop:e2e-personal-version",
    ] {
        assert!(!author_source::personal_manifest_name_matches_slug(
            name,
            "desktop-e2e-personal-version"
        ));
    }
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
