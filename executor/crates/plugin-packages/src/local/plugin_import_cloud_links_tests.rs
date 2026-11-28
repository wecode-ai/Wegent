use super::*;
use tempfile::TempDir;

#[derive(Clone, Copy, Debug)]
enum Mutation {
    Link,
    Unlink,
    Delete,
}

impl Mutation {
    fn apply(self, marketplace: &Path) -> Result<(), String> {
        let marketplace_path = marketplace.display().to_string();
        match self {
            Self::Link => link_plugin_release(LinkPluginReleaseRequest {
                marketplace_path,
                local_plugin_name: "target-plugin".to_owned(),
                cloud_plugin_id: 41,
                cloud_release_id: Some(53),
                account_install: None,
                account_scope: None,
            }),
            Self::Unlink => unlink_plugin_release(UnlinkPluginReleaseRequest {
                marketplace_path,
                local_plugin_name: "target-plugin".to_owned(),
            }),
            Self::Delete => delete_personal_plugin(DeletePersonalPluginRequest {
                marketplace_path,
                plugin_name: "target-plugin".to_owned(),
            }),
        }
    }
}

fn marketplace_fixture() -> TempDir {
    let marketplace = TempDir::new().unwrap();
    for name in ["target-plugin", "other-plugin"] {
        let plugin = marketplace.path().join("plugins").join(name);
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(
            plugin.join(".codex-plugin/plugin.json"),
            serde_json::to_vec(&json!({ "name": name, "version": "1.0.0" })).unwrap(),
        )
        .unwrap();
        fs::write(plugin.join("README.md"), name).unwrap();
        for manifest in [
            ".agents/plugins/marketplace.json",
            ".claude-plugin/marketplace.json",
        ] {
            upsert_marketplace_plugin_entry(&marketplace.path().join(manifest), name).unwrap();
        }
    }
    write_plugin_cloud_links(
        marketplace.path(),
        vec![
            LocalPluginCloudLink {
                local_plugin_name: "target-plugin".to_owned(),
                cloud_plugin_id: 41,
                cloud_release_id: Some(52),
                account_scope: None,
            },
            LocalPluginCloudLink {
                local_plugin_name: "other-plugin".to_owned(),
                cloud_plugin_id: 99,
                cloud_release_id: Some(100),
                account_scope: None,
            },
        ],
    )
    .unwrap();
    marketplace
}

#[test]
fn account_install_cannot_replace_a_different_cloud_plugin_link() {
    let marketplace = marketplace_fixture();
    let path = plugin_cloud_link_registry_path(marketplace.path());
    let original = fs::read(&path).unwrap();
    for mode in [
        AccountInstallLinkMode::KeepRelease,
        AccountInstallLinkMode::UpdateRelease,
    ] {
        let result = link_plugin_release(LinkPluginReleaseRequest {
            marketplace_path: marketplace.path().display().to_string(),
            local_plugin_name: "target-plugin".to_owned(),
            cloud_plugin_id: 99,
            cloud_release_id: Some(100),
            account_install: Some(mode),
            account_scope: None,
        });
        assert_eq!(result.unwrap_err(), "PLUGIN_PERSONAL_SOURCE_LINK_CONFLICT");
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}

#[test]
fn account_install_preserves_the_linked_release_when_reusing_a_cloud_plugin() {
    let marketplace = marketplace_fixture();
    let path = plugin_cloud_link_registry_path(marketplace.path());
    let original = fs::read(&path).unwrap();
    link_plugin_release(LinkPluginReleaseRequest {
        marketplace_path: marketplace.path().display().to_string(),
        local_plugin_name: "target-plugin".to_owned(),
        cloud_plugin_id: 41,
        cloud_release_id: Some(53),
        account_install: Some(AccountInstallLinkMode::KeepRelease),
        account_scope: None,
    })
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn explicit_account_links_adopt_legacy_scope_and_preserve_other_profiles() {
    let marketplace = marketplace_fixture();
    let scope_a = PluginAccountScope::new("https://backend-a.example/", 7).unwrap();
    let scope_b = PluginAccountScope::new("https://backend-b.example", 7).unwrap();
    for scope in [&scope_a, &scope_b] {
        link_plugin_release(LinkPluginReleaseRequest {
            marketplace_path: marketplace.path().display().to_string(),
            local_plugin_name: "target-plugin".into(),
            cloud_plugin_id: 41,
            cloud_release_id: Some(53),
            account_install: Some(AccountInstallLinkMode::KeepRelease),
            account_scope: Some(scope.clone()),
        })
        .unwrap();
    }
    let links = read_plugin_cloud_links_strict(marketplace.path()).unwrap();
    let target: Vec<_> = links
        .iter()
        .filter(|link| link.local_plugin_name == "target-plugin")
        .collect();
    assert_eq!(target.len(), 2);
    assert!(target
        .iter()
        .any(|link| link.account_scope.as_ref() == Some(&scope_a)
            && link.cloud_release_id == Some(52)));
    assert!(target
        .iter()
        .any(|link| link.account_scope.as_ref() == Some(&scope_b)
            && link.cloud_release_id == Some(53)));
    assert!(links
        .iter()
        .any(|link| link.local_plugin_name == "other-plugin" && link.cloud_plugin_id == 99));
    assert!(
        personal_plugin_cloud_link_matches(marketplace.path(), "target-plugin", 41, &scope_a)
            .unwrap()
    );
    assert!(!personal_plugin_cloud_link_matches(
        marketplace.path(),
        "target-plugin",
        41,
        &PluginAccountScope::new("https://backend-a.example", 8).unwrap()
    )
    .unwrap());
}

fn assert_personal_state_preserved(marketplace: &Path, manifests: &[Vec<u8>]) {
    for (index, manifest) in [
        ".agents/plugins/marketplace.json",
        ".claude-plugin/marketplace.json",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            fs::read(marketplace.join(manifest)).unwrap(),
            manifests[index]
        );
    }
    for name in ["target-plugin", "other-plugin"] {
        let plugin = marketplace.join("plugins").join(name);
        assert!(plugin.join(".codex-plugin/plugin.json").is_file());
        assert_eq!(fs::read_to_string(plugin.join("README.md")).unwrap(), name);
    }
}

fn rejects_invalid_registry(mutation: Mutation) {
    let marketplace = marketplace_fixture();
    let path = plugin_cloud_link_registry_path(marketplace.path());
    let mut invalid = fs::read(&path).unwrap();
    invalid.extend_from_slice(b"truncated-write");
    fs::write(&path, &invalid).unwrap();
    let manifests = [
        ".agents/plugins/marketplace.json",
        ".claude-plugin/marketplace.json",
    ]
    .map(|manifest| fs::read(marketplace.path().join(manifest)).unwrap());

    let error = mutation.apply(marketplace.path()).unwrap_err();

    assert!(
        error.starts_with("Invalid plugin cloud link registry:"),
        "{mutation:?}: {error}"
    );
    assert_eq!(fs::read(&path).unwrap(), invalid, "{mutation:?}");
    assert_personal_state_preserved(marketplace.path(), &manifests);
}

#[test]
fn linking_rejects_invalid_cloud_registry_without_losing_other_links() {
    rejects_invalid_registry(Mutation::Link);
}

#[test]
fn unlinking_rejects_invalid_cloud_registry_without_losing_other_links() {
    rejects_invalid_registry(Mutation::Unlink);
}

#[test]
fn deleting_rejects_invalid_cloud_registry_and_restores_personal_state() {
    rejects_invalid_registry(Mutation::Delete);
}

#[test]
fn cloud_link_mutations_reject_unreadable_registry_and_preserve_personal_state() {
    for mutation in [Mutation::Link, Mutation::Unlink, Mutation::Delete] {
        let marketplace = marketplace_fixture();
        let path = plugin_cloud_link_registry_path(marketplace.path());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("marker"), "unreadable registry").unwrap();
        let manifests = [
            ".agents/plugins/marketplace.json",
            ".claude-plugin/marketplace.json",
        ]
        .map(|manifest| fs::read(marketplace.path().join(manifest)).unwrap());

        let error = mutation.apply(marketplace.path()).unwrap_err();

        assert!(
            error.starts_with("Failed to read "),
            "{mutation:?}: {error}"
        );
        assert_eq!(
            fs::read_to_string(path.join("marker")).unwrap(),
            "unreadable registry"
        );
        assert_personal_state_preserved(marketplace.path(), &manifests);
    }
}

#[test]
fn cloud_link_mutations_preserve_other_plugins_and_accept_missing_registry() {
    for mutation in [Mutation::Link, Mutation::Unlink, Mutation::Delete] {
        for missing in [false, true] {
            let marketplace = marketplace_fixture();
            if missing {
                fs::remove_file(plugin_cloud_link_registry_path(marketplace.path())).unwrap();
            }

            mutation.apply(marketplace.path()).unwrap();

            let links = read_plugin_cloud_links_strict(marketplace.path()).unwrap();
            let other = links
                .iter()
                .find(|link| link.local_plugin_name == "other-plugin");
            if missing {
                assert!(other.is_none());
            } else {
                assert_eq!(other.unwrap().cloud_plugin_id, 99);
                assert_eq!(other.unwrap().cloud_release_id, Some(100));
            }
            let target = links
                .iter()
                .find(|link| link.local_plugin_name == "target-plugin");
            if matches!(mutation, Mutation::Link) {
                assert_eq!(target.unwrap().cloud_plugin_id, 41);
                assert_eq!(target.unwrap().cloud_release_id, Some(53));
            } else {
                assert!(target.is_none());
            }
            assert!(marketplace
                .path()
                .join("plugins/other-plugin/README.md")
                .is_file());
            assert_eq!(
                marketplace
                    .path()
                    .join("plugins/target-plugin/README.md")
                    .is_file(),
                !matches!(mutation, Mutation::Delete)
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn deletion_does_not_remove_an_unreadable_regular_cloud_registry() {
    use std::os::unix::fs::PermissionsExt;

    let marketplace = marketplace_fixture();
    let path = plugin_cloud_link_registry_path(marketplace.path());
    let registry = fs::read(&path).unwrap();
    let permissions = fs::metadata(&path).unwrap().permissions();
    let manifests = [
        ".agents/plugins/marketplace.json",
        ".claude-plugin/marketplace.json",
    ]
    .map(|manifest| fs::read(marketplace.path().join(manifest)).unwrap());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

    let result = Mutation::Delete.apply(marketplace.path());

    assert!(path.is_file(), "Unreadable cloud registry was removed");
    fs::set_permissions(&path, permissions).unwrap();
    assert!(result.unwrap_err().starts_with("Failed to read "));
    assert_eq!(fs::read(&path).unwrap(), registry);
    assert_personal_state_preserved(marketplace.path(), &manifests);
}
