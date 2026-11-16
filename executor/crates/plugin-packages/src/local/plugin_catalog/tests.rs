use super::*;

fn read_local_plugin_manifest(
    marketplace_path: &Path,
    plugin_name: &str,
    root: &Path,
) -> Result<Value, String> {
    super::read_local_plugin_manifest(
        marketplace_path,
        plugin_name,
        &root.join("codex"),
        &root.join("capabilities/manifest-v2.json"),
        &root.join("workbench/shared/plugins"),
    )
}

fn registered_store_plugin_roots(
    marketplace_root: &Path,
    plugin_name: &str,
    root: &Path,
) -> Result<Vec<PathBuf>, String> {
    super::registered_store_plugin_roots(
        marketplace_root,
        plugin_name,
        &root.join("codex"),
        &root.join("capabilities/manifest-v2.json"),
        &root.join("workbench/shared/plugins"),
    )
}
use serde_json::json;

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn write_plugin(root: &Path, name: &str, connectors: Value) {
    write_json(
        &root.join(".codex-plugin/plugin.json"),
        &json!({
            "name": name,
            "version": "1.2.3",
            "description": "Example plugin",
            "interface": {
                "displayName": "Example Plugin",
                "logo": "./icon.png",
                "category": "Productivity",
                "defaultPrompt": ["Build an example"]
            },
            "connectors": connectors
        }),
    );
    fs::write(root.join("README.md"), "example").unwrap();
}

#[test]
fn lists_only_plugins_inside_the_managed_store() {
    let temp = tempfile::tempdir().unwrap();
    let capabilities = temp.path().join("capabilities");
    let plugin_root = capabilities.join("store/plugins/example@wegent");
    let outside_root = temp.path().join("outside-plugin");
    write_plugin(&plugin_root, "example", json!([]));
    write_plugin(&outside_root, "outside", json!([]));
    write_json(
        &capabilities.join("manifest.json"),
        &json!({
            "plugins": {
                "example@wegent": {
                    "name": "example",
                    "installed_plugin_id": 104,
                    "marketplace": "wegent",
                    "version": "1.0.0",
                    "enabled": false,
                    "store_path": "store/plugins/example@wegent"
                },
                "outside@wegent": {
                    "name": "outside",
                    "marketplace": "wegent",
                    "store_path": outside_root
                }
            }
        }),
    );

    let listed = list_wegent_store_plugins_at(temp.path()).unwrap();

    assert_eq!(listed.plugins.len(), 1);
    assert_eq!(listed.plugins[0].name, "example");
    assert_eq!(listed.plugins[0].package_id, "example@wegent");
    assert_eq!(listed.plugins[0].installed_plugin_id, Some(104));
    assert_eq!(listed.plugins[0].marketplace, "wegent");
    assert!(!listed.plugins[0].enabled);
    assert_eq!(listed.plugins[0].version.as_deref(), Some("1.2.3"));
    assert_eq!(
        listed.plugins[0].default_prompt,
        Some(json!(["Build an example"]))
    );
}

#[test]
fn relocated_catalog_lists_legacy_and_shared_packages_without_a_legacy_store_dependency() {
    let temp = tempfile::tempdir().unwrap();
    let capabilities = temp.path().join("workbench/wework/test/capabilities");
    let shared = temp.path().join("workbench/shared/plugins");
    let digest = "a".repeat(64);
    let shared_package = shared.join(&digest);
    write_plugin(&shared_package, "shared", json!([]));
    let manifest = capabilities.join("manifest.json");
    let mut entries = json!({"plugins": {
        "shared": {"name":"shared", "marketplace":"wegent", "store_path":shared_package,
            "checksum":format!("sha256:{digest}")},
        "wrong-hash": {"name":"wrong-hash", "store_path":shared_package,
            "checksum":format!("sha256:{}", "b".repeat(64))},
        "store-root": {"name":"store-root", "store_path":shared,
            "checksum":format!("sha256:{digest}")}
    }});
    write_json(&manifest, &entries);
    let listed = list_wegent_store_plugins_from_roots(&manifest, &shared).unwrap();
    assert_eq!(listed.plugins.len(), 1);
    assert_eq!(listed.plugins[0].name, "shared");
    assert_eq!(listed.store_path, shared.display().to_string());
    assert!(!capabilities.join("store/plugins").exists());

    let legacy = capabilities.join("store/plugins/legacy");
    write_plugin(&legacy, "legacy", json!([]));
    entries["plugins"]["legacy"] =
        json!({"name":"legacy", "marketplace":"wegent", "store_path":"store/plugins/legacy"});
    write_json(&manifest, &entries);
    assert_eq!(
        list_wegent_store_plugins_from_roots(&manifest, &shared)
            .unwrap()
            .plugins
            .len(),
        2
    );
}

#[cfg(unix)]
#[test]
fn shared_package_rejects_symlink_aliases_and_nested_or_sibling_directories() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let capabilities = temp.path().join("capabilities");
    let shared = temp.path().join("shared/plugins");
    let digest = "a".repeat(64);
    let root = shared.join(&digest);
    fs::create_dir_all(root.join("nested")).unwrap();
    let entry = |path: &Path| json!({"store_path":path,"checksum":format!("sha256:{digest}")});
    assert_eq!(
        managed_plugin_root(&capabilities, &shared, &entry(&root)).unwrap(),
        root.canonicalize().unwrap()
    );
    assert!(managed_plugin_root(&capabilities, &shared, &entry(&root.join("nested"))).is_err());
    let sibling = shared.join("b".repeat(64));
    fs::create_dir(&sibling).unwrap();
    assert!(managed_plugin_root(&capabilities, &shared, &entry(&sibling)).is_err());
    assert!(managed_plugin_root(&capabilities, &shared, &json!({"store_path":root})).is_err());
    let alias = temp.path().join("alias");
    symlink(&root, &alias).unwrap();
    assert!(managed_plugin_root(&capabilities, &shared, &entry(&alias)).is_err());
    let outside = temp.path().join("outside");
    fs::rename(&root, &outside).unwrap();
    symlink(&outside, &root).unwrap();
    assert!(managed_plugin_root(&capabilities, &shared, &entry(&root)).is_err());
}

#[test]
fn reads_connectors_from_a_manifest_declared_local_source() {
    let temp = tempfile::tempdir().unwrap();
    let marketplace_root = temp.path().join("wework-personal");
    let plugin_root = marketplace_root.join("plugins/example-plugin");
    write_plugin(
        &plugin_root,
        "example-plugin",
        json!([{"id": "example", "type": "oauth"}]),
    );
    let marketplace_manifest = marketplace_root.join(".agents/plugins/marketplace.json");
    write_json(
        &marketplace_manifest,
        &json!({
            "name": "wework-personal",
            "plugins": [{
                "name": "example-plugin",
                "source": {"source": "local", "path": "./plugins/example-plugin"}
            }]
        }),
    );

    let manifest =
        read_local_plugin_manifest(&marketplace_manifest, "example-plugin", temp.path()).unwrap();

    assert_eq!(manifest["connectors"][0]["id"], "example");
    assert!(read_local_plugin_manifest(&marketplace_manifest, "../outside", temp.path()).is_err());
}

#[test]
fn ignores_marketplace_sources_that_escape_the_marketplace_root() {
    let temp = tempfile::tempdir().unwrap();
    let marketplace_root = temp.path().join("marketplace");
    let outside_root = temp.path().join("outside");
    write_plugin(&outside_root, "outside", json!([{"id": "secret"}]));
    let marketplace_manifest = marketplace_root.join("marketplace.json");
    write_json(
        &marketplace_manifest,
        &json!({
            "plugins": [{"name": "outside", "source": "../outside"}]
        }),
    );

    let error =
        read_local_plugin_manifest(&marketplace_manifest, "outside", temp.path()).unwrap_err();

    assert_eq!(error, "Local plugin manifest is unavailable");
}

#[test]
fn registered_store_roots_require_matching_runtime_marketplace_and_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let marketplace = temp.path().join("codex/plugins/marketplaces/wegent");
    fs::create_dir_all(&marketplace).unwrap();
    let plugin = temp
        .path()
        .join("workbench/shared/plugins")
        .join("a".repeat(64));
    write_plugin(&plugin, "wiki", json!([]));
    write_json(
        &temp.path().join("capabilities/manifest-v2.json"),
        &json!({"plugins": {"wiki@wegent": {
            "name": "wiki", "marketplace": "wegent", "installed_plugin_id": 60,
            "store_path": plugin, "checksum": format!("sha256:{}", "a".repeat(64))
        }}}),
    );
    let marketplace = marketplace.canonicalize().unwrap();
    let roots = registered_store_plugin_roots(&marketplace, "wiki", temp.path()).unwrap();
    assert_eq!(roots, vec![plugin.canonicalize().unwrap()]);
    assert!(
        registered_store_plugin_roots(&marketplace, "other", temp.path())
            .unwrap()
            .is_empty()
    );
    let foreign = temp.path().join("foreign/wegent");
    fs::create_dir_all(&foreign).unwrap();
    assert!(
        registered_store_plugin_roots(&foreign.canonicalize().unwrap(), "wiki", temp.path())
            .unwrap()
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn reads_registered_store_symlinks_but_rejects_unregistered_targets() {
    let temp = tempfile::tempdir().unwrap();
    let marketplace = temp.path().join("codex/plugins/marketplaces/wegent");
    let market_manifest = marketplace.join(".agents/plugins/marketplace.json");
    let plugin = temp
        .path()
        .join("workbench/shared/plugins")
        .join("a".repeat(64));
    let outside = temp.path().join("outside-plugin");
    let connector = json!([{"slug": "wiki", "authPolicy": "on_use", "localAuth": {
        "kind": "local_qr", "health": ["health"], "start": ["start"], "poll": ["poll"]
    }}]);
    write_plugin(&plugin, "wiki", connector.clone());
    write_plugin(&outside, "wiki", connector.clone());
    let native = temp.path().join("codex/plugins/cache/wegent/wiki/1.0.0");
    write_plugin(&native, "wiki", connector);
    write_json(
        &market_manifest,
        &json!({"name": "wegent", "plugins": [{
            "name": "wiki", "source": {"source": "local", "path": "./plugins/wiki"}
        }]}),
    );
    let registry = temp.path().join("capabilities/manifest-v2.json");
    let entry = json!({"plugins": {"wiki@wegent": {
        "name": "wiki", "marketplace": "wegent", "installed_plugin_id": 60,
        "store_path": plugin, "checksum": format!("sha256:{}", "a".repeat(64)),
        "version": "1.0.0", "runtime": {"codex_link": native}
    }}});
    write_json(&registry, &entry);
    let link = marketplace.join("plugins/wiki");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    for target in [&plugin, &native] {
        std::os::unix::fs::symlink(target, &link).unwrap();
        for path in [&marketplace, &market_manifest] {
            let manifest = read_local_plugin_manifest(path, "wiki", temp.path()).unwrap();
            assert_eq!(manifest["connectors"][0]["localAuth"]["kind"], "local_qr");
        }
        fs::remove_file(&link).unwrap();
    }
    std::os::unix::fs::symlink(&native, &link).unwrap();
    let mut wrong_market = entry.clone();
    wrong_market["plugins"]["wiki@wegent"]["marketplace"] = json!("other");
    write_json(&registry, &wrong_market);
    assert!(read_local_plugin_manifest(&market_manifest, "wiki", temp.path()).is_err());
    write_json(&registry, &entry);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(read_local_plugin_manifest(&market_manifest, "wiki", temp.path()).is_err());
    let mut escaped_runtime = entry.clone();
    escaped_runtime["plugins"]["wiki@wegent"]["runtime"]["codex_link"] = json!(outside);
    write_json(&registry, &escaped_runtime);
    assert!(read_local_plugin_manifest(&market_manifest, "wiki", temp.path()).is_err());
    let mut escaped_store = entry;
    escaped_store["plugins"]["wiki@wegent"]["store_path"] = json!(outside);
    write_json(&registry, &escaped_store);
    assert!(read_local_plugin_manifest(&market_manifest, "wiki", temp.path()).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symbolic_links_in_the_example_and_destination() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    write_plugin(&source, PLUGIN_EXAMPLE_DIRECTORY, json!([]));
    symlink(source.join("README.md"), source.join("linked.md")).unwrap();
    let destination = temp.path().join("example.zip");

    let error = save_plugin_example_from_source(&source, &destination).unwrap_err();
    assert!(error.contains("symbolic links"));

    fs::remove_file(source.join("linked.md")).unwrap();
    fs::write(&destination, "old").unwrap();
    let linked_destination = temp.path().join("linked.zip");
    symlink(&destination, &linked_destination).unwrap();
    let error = save_plugin_example_from_source(&source, &linked_destination).unwrap_err();
    assert!(error.contains("cannot be a symbolic link"));
}
