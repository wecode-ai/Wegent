use super::*;
use std::io::Cursor;
use tempfile::TempDir;
use zip::{write::FileOptions, ZipWriter};

fn plugin_zip(name: &str) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = ZipWriter::new(cursor);
    archive
        .start_file(".codex-plugin/plugin.json", FileOptions::default())
        .unwrap();
    archive
        .write_all(
            serde_json::to_string(&json!({
                "name": name,
                "version": "1.0.0",
                "description": "Test plugin",
                "author": { "name": "Wework" },
                "interface": {
                    "displayName": "Test Plugin",
                    "shortDescription": "Short",
                    "longDescription": "Long",
                    "developerName": "Wework",
                    "category": "development",
                    "capabilities": [],
                    "defaultPrompt": "Test"
                },
                "mcpServers": {
                    "remote": { "type": "http", "url": "https://example.com/mcp" }
                }
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
    archive.finish().unwrap().into_inner()
}

fn write_personal_plugin(marketplace: &Path, name: &str) {
    let plugin_root = marketplace.join("plugins").join(name);
    fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        serde_json::to_vec_pretty(&json!({
            "name": name,
            "version": "1.2.3",
            "description": "Personal plugin",
            "interface": {
                "displayName": "Example Plugin",
                "category": "development"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(plugin_root.join("README.md"), "plugin body").unwrap();
}

fn plugin_copy_request(marketplace: &Path, package: &[u8]) -> ImportPersonalPluginCopyRequest {
    ImportPersonalPluginCopyRequest {
        marketplace_path: marketplace.display().to_string(),
        download_url: "https://objects.example/plugin.zip".to_owned(),
        sha256: format!("{:x}", Sha256::digest(package)),
        source_plugin_id: 41,
        source_release_id: 52,
        source_plugin_name: "example-plugin".to_owned(),
        source_display_name: "Example Plugin".to_owned(),
    }
}

#[test]
fn imports_and_rolls_back_personal_plugin_copy_transactionally() {
    let temp = TempDir::new().unwrap();
    let marketplace = temp.path().join("wework-personal");
    fs::create_dir_all(&marketplace).unwrap();
    let package = plugin_zip("example-plugin");
    let request = plugin_copy_request(&marketplace, &package);

    let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();

    assert_eq!(imported.plugin_name, "example-plugin-copy");
    assert_eq!(imported.display_name, "Example Plugin · 我的副本");
    let manifest: Value = serde_json::from_slice(
        &fs::read(marketplace.join("plugins/example-plugin-copy/.codex-plugin/plugin.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["name"], "example-plugin-copy");
    assert_eq!(manifest["version"], "0.1.0");
    for path in [
        marketplace.join(".agents/plugins/marketplace.json"),
        marketplace.join(".claude-plugin/marketplace.json"),
    ] {
        assert!(marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
    }
    let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
    assert_eq!(registry.copies.len(), 1);
    assert_eq!(registry.copies[0].source_plugin_id, 41);

    rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap();
    rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap();

    assert!(!marketplace.join("plugins/example-plugin-copy").exists());
    let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
    assert!(registry.copies.is_empty());
    for path in [
        marketplace.join(".agents/plugins/marketplace.json"),
        marketplace.join(".claude-plugin/marketplace.json"),
    ] {
        assert!(!marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
    }
}

#[test]
fn deleting_personal_copy_cleans_provenance_and_rolls_it_back_on_failure() {
    let temp = TempDir::new().unwrap();
    let marketplace = temp.path().join("wework-personal");
    fs::create_dir_all(&marketplace).unwrap();
    let package = plugin_zip("example-plugin");
    let request = plugin_copy_request(&marketplace, &package);
    let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
    let cloud_link_path = plugin_cloud_link_registry_path(&marketplace);
    fs::write(&cloud_link_path, b"invalid cloud registry").unwrap();

    let error = delete_personal_plugin(DeletePersonalPluginRequest {
        marketplace_path: marketplace.display().to_string(),
        plugin_name: imported.plugin_name.clone(),
    })
    .unwrap_err();

    assert!(
        error.starts_with("Invalid plugin cloud link registry:"),
        "{error}"
    );
    assert_eq!(
        fs::read(&cloud_link_path).unwrap(),
        b"invalid cloud registry"
    );
    assert!(marketplace
        .join("plugins/example-plugin-copy/.codex-plugin/plugin.json")
        .is_file());
    let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
    assert_eq!(registry.copies.len(), 1);
    for path in [
        marketplace.join(".agents/plugins/marketplace.json"),
        marketplace.join(".claude-plugin/marketplace.json"),
    ] {
        assert!(marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
    }

    fs::remove_file(&cloud_link_path).unwrap();
    delete_personal_plugin(DeletePersonalPluginRequest {
        marketplace_path: marketplace.display().to_string(),
        plugin_name: imported.plugin_name,
    })
    .unwrap();

    assert!(!marketplace.join("plugins/example-plugin-copy").exists());
    let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
    assert!(registry.copies.is_empty());
}

#[test]
fn personal_plugin_copy_rejects_checksum_and_archive_path_escape() {
    let temp = TempDir::new().unwrap();
    let marketplace = temp.path().join("wework-personal");
    fs::create_dir_all(&marketplace).unwrap();
    let package = plugin_zip("example-plugin");
    let mut request = plugin_copy_request(&marketplace, &package);
    request.sha256 = "0".repeat(64);
    let error = import_plugin_copy_package(&marketplace, &package, &request).unwrap_err();
    assert_eq!(error, "Plugin copy checksum mismatch");
    assert!(!marketplace.join("plugins").exists());

    let cursor = Cursor::new(Vec::new());
    let mut archive = ZipWriter::new(cursor);
    archive
        .start_file(".codex-plugin/plugin.json", FileOptions::default())
        .unwrap();
    archive
        .write_all(br#"{"name":"example-plugin","version":"1.0.0"}"#)
        .unwrap();
    archive
        .start_file("../escape", FileOptions::default())
        .unwrap();
    archive.write_all(b"escape").unwrap();
    let unsafe_package = archive.finish().unwrap().into_inner();
    let request = plugin_copy_request(&marketplace, &unsafe_package);
    let error = import_plugin_copy_package(&marketplace, &unsafe_package, &request).unwrap_err();
    assert!(error.contains("unsafe path"), "unexpected error: {error}");
    assert!(!temp.path().join("escape").exists());
}

#[cfg(unix)]
#[test]
fn personal_plugin_copy_rollback_rejects_symbolic_link_escape() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let marketplace = temp.path().join("wework-personal");
    fs::create_dir_all(&marketplace).unwrap();
    let package = plugin_zip("example-plugin");
    let request = plugin_copy_request(&marketplace, &package);
    let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
    let plugin_path = marketplace.join("plugins/example-plugin-copy");
    fs::remove_dir_all(&plugin_path).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "outside").unwrap();
    symlink(&outside, &plugin_path).unwrap();

    let error = rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap_err();

    assert!(error.contains("regular managed directory"));
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "outside");
}

#[cfg(unix)]
#[test]
fn personal_plugin_copy_rollback_read_failure_keeps_primary_plugin_path() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let marketplace = temp.path().join("wework-personal");
    fs::create_dir_all(&marketplace).unwrap();
    let package = plugin_zip("example-plugin");
    let request = plugin_copy_request(&marketplace, &package);
    let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
    let marketplace_manifest = marketplace.join(".agents/plugins/marketplace.json");
    fs::set_permissions(&marketplace_manifest, fs::Permissions::from_mode(0o000)).unwrap();

    let error = rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap_err();

    assert!(error.contains("Failed to read"));
    assert!(marketplace
        .join("plugins/example-plugin-copy/.codex-plugin/plugin.json")
        .is_file());
    assert!(!marketplace
        .join("plugins/.example-plugin-copy-rollback")
        .exists());
    fs::set_permissions(&marketplace_manifest, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn plugin_copy_download_url_allows_only_bounded_http_urls() {
    assert!(validated_plugin_copy_download_url(
        "https://objects.example/plugins/example.zip?signature=abc"
    )
    .is_ok());
    for value in [
        "file:///tmp/plugin.zip",
        "https://user:secret@objects.example/plugin.zip",
        "https://objects.example/plugin.zip#fragment",
        "relative/plugin.zip",
    ] {
        assert!(
            validated_plugin_copy_download_url(value).is_err(),
            "{value}"
        );
    }
}

#[cfg(unix)]
#[test]
fn personal_marketplace_rejects_managed_ancestor_symlinks() {
    use std::os::unix::fs::symlink;

    for relative_link in [
        "",
        "capabilities",
        "capabilities/bundled-marketplaces",
        "capabilities/bundled-marketplaces/wework-personal",
    ] {
        let temp = TempDir::new().unwrap();
        let executor_home = temp.path().join("executor-home");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let link = if relative_link.is_empty() {
            executor_home.clone()
        } else {
            executor_home.join(relative_link)
        };
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&outside, &link).unwrap();
        let marketplace = executor_home
            .join("capabilities")
            .join("bundled-marketplaces")
            .join(PERSONAL_MARKETPLACE_ID);

        let validation_error = validated_personal_marketplace_path_for_executor_home(
            &marketplace.display().to_string(),
            &executor_home,
        )
        .expect_err("managed marketplace symlinks must be rejected during validation");
        assert!(
            validation_error.contains("symbolic link"),
            "unexpected validation error for {relative_link:?}: {validation_error}"
        );

        let preparation_error =
            prepare_personal_marketplace_root_for_executor_home(&marketplace, &executor_home)
                .expect_err("managed marketplace symlinks must be rejected during preparation");
        assert!(
            preparation_error.contains("symbolic link"),
            "unexpected preparation error for {relative_link:?}: {preparation_error}"
        );
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}

#[test]
fn ensures_lists_and_packages_personal_plugins_idempotently() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let executor_home = temp.path().join("executor-home");
    let destination = executor_home
        .join("capabilities")
        .join("bundled-marketplaces")
        .join(PERSONAL_MARKETPLACE_ID);
    write_personal_plugin(&source, "example-plugin");
    assert_eq!(
        validated_personal_marketplace_path_for_executor_home(
            &destination.display().to_string(),
            &executor_home,
        )
        .unwrap(),
        destination
    );

    let first = ensure_personal_plugin_at(&source, &destination, "example-plugin").unwrap();
    assert!(first.migrated);
    assert_eq!(first.plugin_name, "example-plugin");
    for manifest in [
        destination.join(".agents/plugins/marketplace.json"),
        destination.join(".claude-plugin/marketplace.json"),
    ] {
        assert!(marketplace_manifest_contains_plugin(&manifest, "example-plugin").unwrap());
    }

    let second = ensure_personal_plugin_at(&destination, &destination, "example-plugin").unwrap();
    assert!(!second.migrated);
    assert_eq!(second.plugin_path, first.plugin_path);

    let listed = list_personal_plugins_at(&destination).unwrap();
    assert_eq!(listed.plugins.len(), 1);
    assert_eq!(listed.plugins[0].name, "example-plugin");
    assert_eq!(listed.plugins[0].version.as_deref(), Some("1.2.3"));
    assert_eq!(
        listed.plugins[0].display_name.as_deref(),
        Some("Example Plugin")
    );

    let artifacts = temp.path().join("artifacts");
    fs::create_dir(&artifacts).unwrap();
    let package = package_plugin_directory(
        &destination.join("plugins/example-plugin"),
        "example-plugin",
        &artifacts,
    )
    .unwrap();
    assert_eq!(package.name, "example-plugin.zip");
    assert_eq!(package.size, fs::metadata(&package.path).unwrap().len());
    assert_eq!(
        package.sha256,
        sha256_file(Path::new(&package.path)).unwrap()
    );
    let mut archive = zip::ZipArchive::new(fs::File::open(&package.path).unwrap()).unwrap();
    assert!(archive.by_name(".codex-plugin/plugin.json").is_ok());
    assert!(archive.by_name("README.md").is_ok());
    remove_personal_package_artifact(&artifacts, &package.cleanup_token).unwrap();
    assert!(!Path::new(&package.path).exists());
}

#[test]
fn relocated_capabilities_support_personal_plugin_install_and_delete() {
    let temp = TempDir::new().unwrap();
    let capabilities = temp
        .path()
        .join("workbench/wework/test/custom-capabilities");
    let source = temp.path().join("source");
    write_personal_plugin(&source, "example-plugin");
    let expected = personal_marketplace_path(&capabilities);
    let validated =
        validated_personal_marketplace_path_for_capabilities("", &capabilities).unwrap();
    assert_eq!(validated, expected);
    let destination =
        prepare_personal_marketplace_root_for_capabilities(&validated, &capabilities).unwrap();
    ensure_personal_plugin_at(&source, &destination, "example-plugin").unwrap();
    assert_eq!(
        list_personal_plugins_at(&destination)
            .unwrap()
            .plugins
            .len(),
        1
    );
    assert_eq!(
        plugin_cloud_link_registry_path(&destination),
        capabilities
            .canonicalize()
            .unwrap()
            .join("plugin-state/wework-personal-cloud-links.json")
    );
    delete_personal_plugin(DeletePersonalPluginRequest {
        marketplace_path: destination.display().to_string(),
        plugin_name: "example-plugin".into(),
    })
    .unwrap();
    assert!(list_personal_plugins_at(&destination)
        .unwrap()
        .plugins
        .is_empty());
    assert!(source.join("plugins/example-plugin/README.md").is_file());
    assert!(!temp.path().join("capabilities").exists());
}

#[cfg(unix)]
#[test]
fn relocated_marketplace_accepts_legacy_bridge_but_rejects_symlinked_managed_children() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let capabilities = temp.path().join("workbench/wework/test/capabilities");
    let expected = personal_marketplace_path(&capabilities);
    prepare_personal_marketplace_root_for_capabilities(&expected, &capabilities).unwrap();
    let legacy = temp.path().join("legacy-capabilities");
    symlink(&capabilities, &legacy).unwrap();
    let requested = personal_marketplace_path(&legacy);
    assert_eq!(
        validated_personal_marketplace_path_for_capabilities(
            requested.to_str().unwrap(),
            &capabilities
        )
        .unwrap(),
        expected
    );

    let outside = temp.path().join("outside");
    fs::rename(&expected, &outside).unwrap();
    symlink(&outside, &expected).unwrap();
    assert!(validated_personal_marketplace_path_for_capabilities("", &capabilities).is_err());
    assert!(prepare_personal_marketplace_root_for_capabilities(&expected, &capabilities).is_err());
}

#[test]
fn relocated_marketplace_rejects_traversal_and_other_roots() {
    let temp = TempDir::new().unwrap();
    let capabilities = temp.path().join("capabilities");
    assert!(
        validated_personal_marketplace_path_for_capabilities("", Path::new("relative")).is_err()
    );
    assert!(validated_personal_marketplace_path_for_capabilities(
        "",
        &capabilities.join("../other")
    )
    .is_err());
    assert!(validated_personal_marketplace_path_for_capabilities(
        temp.path().join("other").to_str().unwrap(),
        &capabilities
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn ensure_result_can_be_packaged_through_a_canonical_parent_alias() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    write_personal_plugin(&source, "example-plugin");
    let real_parent = temp.path().join("real-parent");
    let alias_parent = temp.path().join("alias-parent");
    fs::create_dir(&real_parent).unwrap();
    symlink(&real_parent, &alias_parent).unwrap();
    let executor_home = alias_parent.join("executor-home");
    let lexical_marketplace = executor_home
        .join("capabilities")
        .join("bundled-marketplaces")
        .join(PERSONAL_MARKETPLACE_ID);
    let validated = validated_personal_marketplace_path_for_executor_home(
        &lexical_marketplace.display().to_string(),
        &executor_home,
    )
    .unwrap();
    let prepared =
        prepare_personal_marketplace_root_for_executor_home(&validated, &executor_home).unwrap();

    let ensured = ensure_personal_plugin_at(&source, &prepared, "example-plugin").unwrap();

    assert_eq!(Path::new(&ensured.marketplace_path), prepared);
    let package_marketplace = validated_personal_marketplace_path_for_executor_home(
        &ensured.marketplace_path,
        &executor_home,
    )
    .unwrap();
    let marketplace_root = resolve_existing_marketplace_root(&package_marketplace).unwrap();
    let plugin_root = resolve_managed_personal_plugin(&marketplace_root, "example-plugin").unwrap();
    let artifacts = temp.path().join("artifacts-canonical-alias");
    fs::create_dir(&artifacts).unwrap();
    let package = package_plugin_directory(&plugin_root, "example-plugin", &artifacts).unwrap();
    assert!(Path::new(&package.path).is_file());
}

#[test]
fn personal_plugin_migration_rejects_path_traversal() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    write_personal_plugin(&source, "example-plugin");

    let error = ensure_personal_plugin_at(&source, &destination, "../example-plugin")
        .expect_err("parent traversal must be rejected");

    assert_eq!(error, "Plugin name is invalid");
    assert!(!destination.join("example-plugin").exists());
}

#[cfg(unix)]
#[test]
fn personal_plugin_migration_rejects_symbolic_links() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    write_personal_plugin(&source, "example-plugin");
    symlink(
        temp.path().join("outside"),
        source.join("plugins/example-plugin/escape"),
    )
    .unwrap();

    let error = ensure_personal_plugin_at(&source, &destination, "example-plugin")
        .expect_err("symbolic links must be rejected");

    assert!(error.contains("cannot contain symbolic links"));
    assert!(!destination.join("plugins/example-plugin").exists());
}

#[cfg(unix)]
#[test]
fn personal_plugin_migration_rejects_manifest_path_symlink_escape() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    write_personal_plugin(&source, "example-plugin");
    for (label, relative, target_is_file) in [
        ("agents", ".agents", false),
        ("agents-plugins", ".agents/plugins", false),
        ("claude", ".claude-plugin", false),
        ("manifest", ".agents/plugins/marketplace.json", true),
    ] {
        let destination = temp.path().join(format!("destination-{label}"));
        let outside = temp.path().join(format!("outside-{label}"));
        fs::create_dir_all(&destination).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = destination.join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let outside_target = if target_is_file {
            let path = outside.join("marketplace.json");
            fs::write(&path, "outside marker").unwrap();
            path
        } else {
            outside.clone()
        };
        symlink(&outside_target, &link).unwrap();

        let error = ensure_personal_plugin_at(&source, &destination, "example-plugin")
            .expect_err("manifest path symbolic links must be rejected");

        assert!(error.contains("symbolic link"), "unexpected error: {error}");
        assert!(!destination.join("plugins/example-plugin").exists());
        if target_is_file {
            assert_eq!(
                fs::read_to_string(outside_target).unwrap(),
                "outside marker"
            );
        } else {
            assert!(fs::read_dir(outside).unwrap().next().is_none());
        }
    }
}

#[test]
fn previews_and_imports_valid_plugin_packages() {
    let temp = TempDir::new().unwrap();
    let archive_path = temp.path().join("plugin.zip");
    fs::write(&archive_path, plugin_zip("example-plugin")).unwrap();
    let marketplace = temp.path().join("marketplace");
    let preview = preview_plugin_import(PreviewPluginImportRequest {
        archive_path: archive_path.display().to_string(),
        marketplace_path: marketplace.display().to_string(),
    })
    .unwrap();
    assert!(preview.valid);
    assert_eq!(preview.mcp_server_count, 1);

    let imported = import_plugin_package(ImportPluginPackageRequest {
        archive_path: archive_path.display().to_string(),
        marketplace_path: marketplace.display().to_string(),
        expected_sha256: preview.sha256,
        overwrite: false,
    })
    .unwrap();
    assert!(Path::new(&imported.plugin_path).is_dir());
    finalize_plugin_import(PluginImportMutationRequest {
        marketplace_path: marketplace.display().to_string(),
        rollback_id: imported.rollback_id,
    })
    .unwrap();

    delete_personal_plugin(DeletePersonalPluginRequest {
        marketplace_path: marketplace.display().to_string(),
        plugin_name: "example-plugin".to_owned(),
    })
    .unwrap();
    delete_personal_plugin(DeletePersonalPluginRequest {
        marketplace_path: marketplace.display().to_string(),
        plugin_name: "example-plugin".to_owned(),
    })
    .unwrap();
    assert!(!marketplace.join("plugins/example-plugin").exists());
    for manifest in [
        marketplace.join(".agents/plugins/marketplace.json"),
        marketplace.join(".claude-plugin/marketplace.json"),
    ] {
        assert!(!marketplace_manifest_contains_plugin(&manifest, "example-plugin").unwrap());
    }
}
