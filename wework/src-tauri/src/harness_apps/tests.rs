use super::*;
use flate2::{write::GzEncoder, Compression};
use std::io::Write;
use tar::Builder;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn manifest(dsh: &str) -> String {
    format!(
        r#"{{
          "name":"test-capability",
          "displayName":"Test capability",
          "version":"0.1.0",
          "type":"deepseek-harness-plugin-bundle",
          "description":"Test",
          "entry":{{
            "installPackage":"packages/bundle/test",
            "profile":"test"
          }},
          "requirements":{{"dsh":"{dsh}","node":">=22"}}
        }}"#
    )
}

fn write_archive(path: &Path, manifest: &str) {
    let file = fs::File::create(path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    archive
        .start_file("wrapper/plugin-manifest.json", options)
        .unwrap();
    archive.write_all(manifest.as_bytes()).unwrap();
    archive
        .start_file("wrapper/packages/bundle/test/cordis.patch.yml", options)
        .unwrap();
    archive
        .write_all(b"plugins:\n  test:\n    provider: deepseek\n    model: default\n")
        .unwrap();
    archive.finish().unwrap();
}

fn write_npm_archive(path: &Path, name: &str, files: &[(&str, &str)]) {
    let file = fs::File::create(path).unwrap();
    let encoder = GzEncoder::new(file, Compression::fast());
    let mut archive = Builder::new(encoder);
    let package = serde_json::json!({ "name": name, "version": "0.1.0" }).to_string();
    let mut entries = vec![("package/package.json", package.as_str())];
    entries.extend_from_slice(files);
    for (path, content) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, path, content.as_bytes())
            .unwrap();
    }
    archive.finish().unwrap();
}

#[test]
fn archive_supports_one_wrapper_directory() {
    let directory = tempdir().unwrap();
    let archive = directory.path().join("plugin.zip");
    let extracted = directory.path().join("extracted");
    write_archive(&archive, &manifest("0.1.0-rc.8"));

    let (inspected, hash) = inspect_archive(&archive, Some(&extracted)).unwrap();

    assert_eq!(inspected.name, "test-capability");
    assert_eq!(hash.len(), 64);
    assert!(extracted.join("plugin-manifest.json").is_file());
    assert!(extracted
        .join("packages/bundle/test/cordis.patch.yml")
        .is_file());
}

#[test]
fn bare_dsh_version_is_an_exact_requirement() {
    let requirement = dsh_version_requirement("0.1.0-rc.8").unwrap();

    assert!(requirement.matches(&Version::parse("0.1.0-rc.8").unwrap()));
    assert!(!requirement.matches(&Version::parse("0.1.0-rc.9").unwrap()));
}

#[test]
fn harness_app_start_disables_the_runtime_browser_handoff() {
    assert_eq!(
        harness_app_start_args("dashboard", 43123),
        ["--profile", "dashboard", "--no-open", "--port", "43123"]
    );
}

#[test]
fn installation_registry_defaults_resident_for_existing_records() {
    let installation: HarnessAppInstallation = serde_json::from_value(serde_json::json!({
        "id": "test-capability",
        "manifest": serde_json::from_str::<Value>(&manifest("0.1.0-rc.8")).unwrap(),
        "packagePath": "/tmp/test-capability",
        "sha256": "hash",
        "modelKey": "model",
        "runtimeVersion": null,
        "state": "installed",
        "webUrl": null,
        "error": null
    }))
    .unwrap();

    assert!(!installation.resident);
    assert!(installation.smart_app_id.is_none());
    assert!(installation.release_id.is_none());
}

#[test]
fn marketplace_installations_isolate_publishers_with_same_manifest_name() {
    assert_eq!(market_installation_id(Some(41), "same-name"), "market-41");
    assert_eq!(market_installation_id(Some(82), "same-name"), "market-82");
    assert_eq!(market_installation_id(None, "same-name"), "same-name");
}

#[test]
fn remote_download_rejects_truncated_content() {
    let directory = tempdir().unwrap();
    let temporary = directory.path().join("app.zip.part");

    let error = write_verified_download(
        std::io::Cursor::new(b"short"),
        &temporary,
        10,
        &"0".repeat(64),
    )
    .unwrap_err();

    assert!(error.contains("incomplete"));
}

#[test]
fn remote_download_rejects_hash_mismatch() {
    let directory = tempdir().unwrap();
    let temporary = directory.path().join("app.zip.part");

    let error = write_verified_download(
        std::io::Cursor::new(b"complete"),
        &temporary,
        8,
        &"0".repeat(64),
    )
    .unwrap_err();

    assert!(error.contains("checksum"));
}

#[test]
fn installed_package_export_is_deterministic_and_valid() {
    let directory = tempdir().unwrap();
    let package = directory.path().join("package");
    fs::create_dir_all(package.join("bundle")).unwrap();
    fs::write(package.join("plugin-manifest.json"), manifest("0.1.0-rc.7")).unwrap();
    fs::write(package.join("bundle/app.js"), "export default {}\n").unwrap();
    let first = directory.path().join("first.zip");
    let second = directory.path().join("second.zip");

    let first_result = export_package_directory(&package, &first).unwrap();
    let second_result = export_package_directory(&package, &second).unwrap();

    assert_eq!(first_result, second_result);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert!(inspect_archive(&first, None).is_ok());
}

#[test]
fn manifest_rejects_install_package_escape() {
    let mut parsed: HarnessAppManifest = serde_json::from_str(&manifest("0.1.0-rc.8")).unwrap();
    parsed.entry.install_package = "../outside".to_string();

    assert!(validate_manifest(&parsed)
        .unwrap_err()
        .contains("installPackage"));
}

#[test]
fn instance_patch_binds_provider_and_model() {
    let directory = tempdir().unwrap();
    let package = directory.path().join("package");
    let bundle = package.join("packages/bundle/test");
    fs::create_dir_all(&bundle).unwrap();
    fs::write(
        bundle.join("cordis.patch.yml"),
        "plugins:\n  test:\n    provider: deepseek\n    model: default\n",
    )
    .unwrap();
    let sibling = package.join("packages/ops/sibling");
    fs::create_dir_all(&sibling).unwrap();
    fs::write(sibling.join("package.json"), "{}\n").unwrap();
    let installation = HarnessAppInstallation {
        id: "test-capability".to_string(),
        manifest: serde_json::from_str(&manifest("0.1.0-rc.8")).unwrap(),
        package_path: package.display().to_string(),
        sha256: "hash".to_string(),
        model_key: Some("model".to_string()),
        resident: false,
        runtime_version: None,
        state: "installed".to_string(),
        web_url: None,
        error: None,
        smart_app_id: None,
        release_id: None,
    };

    let output = prepare_instance_bundle(&installation, directory.path(), true)
        .unwrap()
        .pop()
        .unwrap();
    let patch = fs::read_to_string(output.join("cordis.patch.yml")).unwrap();

    assert!(patch.contains("provider: wework-local"));
    assert!(patch.contains("model: wework-selected"));
    assert!(directory
        .path()
        .join("wework-package/packages/bundle/test")
        .is_dir());
    assert!(directory
        .path()
        .join("wework-package/packages/ops/sibling/package.json")
        .is_file());
}

#[test]
fn standard_dsh_release_materializes_and_installs_all_declared_packages() {
    let directory = tempdir().unwrap();
    let package = directory.path().join("package");
    fs::create_dir_all(&package).unwrap();
    write_npm_archive(
        &package.join("dashboard.tgz"),
        "@example/dashboard",
        &[("package/lib/index.js", "export default {}\n")],
    );
    write_npm_archive(
        &package.join("dashboard-app.tgz"),
        "@example/dashboard-app",
        &[(
            "package/cordis.patch.yml",
            "- insert:\n    - id: dashboard\n      name: '@example/dashboard'\n",
        )],
    );
    let manifest: HarnessAppManifest = serde_json::from_value(serde_json::json!({
        "name": "dashboard",
        "displayName": "Dashboard",
        "version": "0.1.0",
        "type": "deepseek-harness-plugin-bundle",
        "description": "Dashboard",
        "packages": [
            {
                "name": "@example/dashboard-app",
                "role": "profile-bundle",
                "path": "packages/bundle/dashboard-app"
            },
            {
                "name": "@example/dashboard",
                "role": "host-and-web-plugin",
                "path": "packages/ops/dashboard"
            }
        ],
        "entry": {
            "installPackage": "packages/bundle/dashboard-app",
            "profile": "web"
        },
        "requirements": {"dsh": "0.1.0-rc.8", "node": ">=22"}
    }))
    .unwrap();
    let installation = HarnessAppInstallation {
        id: "dashboard".to_string(),
        manifest,
        package_path: package.display().to_string(),
        sha256: "hash".to_string(),
        model_key: Some("model".to_string()),
        resident: false,
        runtime_version: None,
        state: "installed".to_string(),
        web_url: None,
        error: None,
        smart_app_id: None,
        release_id: None,
    };

    let packages = prepare_instance_bundle(&installation, directory.path(), true).unwrap();

    assert_eq!(packages.len(), 2);
    assert!(packages[0].ends_with("packages/ops/dashboard"));
    assert!(packages[1].ends_with("packages/bundle/dashboard-app"));
    let patch = fs::read_to_string(packages[1].join("cordis.patch.yml")).unwrap();
    assert!(patch.contains("- id: agent-default-model"));
    assert!(patch.contains("provider: wework-local"));
}

#[test]
fn instance_patch_adds_agent_default_model_when_the_bundle_has_no_model_fields() {
    let directory = tempdir().unwrap();
    let package = directory.path().join("package");
    let bundle = package.join("packages/bundle/test");
    fs::create_dir_all(&bundle).unwrap();
    fs::write(
        bundle.join("cordis.patch.yml"),
        "- insert:\n    - id: scanner\n      name: scanner\n",
    )
    .unwrap();
    let installation = HarnessAppInstallation {
        id: "test-capability".to_string(),
        manifest: serde_json::from_str(&manifest("0.1.0-rc.7")).unwrap(),
        package_path: package.display().to_string(),
        sha256: "hash".to_string(),
        model_key: Some("model".to_string()),
        resident: false,
        runtime_version: None,
        state: "installed".to_string(),
        web_url: None,
        error: None,
        smart_app_id: None,
        release_id: None,
    };

    let output = prepare_instance_bundle(&installation, directory.path(), true)
        .unwrap()
        .pop()
        .unwrap();
    let patch = fs::read_to_string(output.join("cordis.patch.yml")).unwrap();

    assert!(patch.contains("- id: scanner"));
    assert!(patch.contains("- id: agent-default-model"));
    assert!(patch.contains("provider: wework-local"));
    assert!(patch.contains("model: wework-selected"));
}

#[test]
fn instance_patch_rejects_an_incomplete_model_pair() {
    let directory = tempdir().unwrap();
    let package = directory.path().join("package");
    let bundle = package.join("packages/bundle/test");
    fs::create_dir_all(&bundle).unwrap();
    fs::write(
        bundle.join("cordis.patch.yml"),
        "- insert:\n    - id: scanner\n      config:\n        provider: deepseek\n",
    )
    .unwrap();
    let installation = HarnessAppInstallation {
        id: "test-capability".to_string(),
        manifest: serde_json::from_str(&manifest("0.1.0-rc.7")).unwrap(),
        package_path: package.display().to_string(),
        sha256: "hash".to_string(),
        model_key: Some("model".to_string()),
        resident: false,
        runtime_version: None,
        state: "installed".to_string(),
        web_url: None,
        error: None,
        smart_app_id: None,
        release_id: None,
    };

    let error = prepare_instance_bundle(&installation, directory.path(), true).unwrap_err();

    assert!(error.contains("incomplete provider/model pair"));
}

#[cfg(unix)]
#[test]
fn node_version_check_initializes_the_runtime() {
    let directory = tempdir().unwrap();
    let node = directory.path().join("node");
    fs::write(
        &node,
        "#!/bin/sh\n\
         test \"$1\" = \"-p\"\n\
         test \"$2\" = \"process.versions.node\"\n\
         printf '24.1.0'\n",
    )
    .unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(read_node_version(&node).unwrap(), Version::new(24, 1, 0));
}

#[cfg(unix)]
#[test]
fn node_version_check_reports_v8_initialization_failures() {
    let directory = tempdir().unwrap();
    let node = directory.path().join("node");
    fs::write(
        &node,
        "#!/bin/sh\n\
         echo 'Failed to reserve virtual memory for CodeRange' >&2\n\
         exit 133\n",
    )
    .unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();

    let error = read_node_version(&node).unwrap_err();

    assert!(error.contains("failed to initialize V8"));
    assert!(error.contains("Failed to reserve virtual memory for CodeRange"));
}
fn runtime_descriptor(
    version: &str,
    fingerprint: char,
    checksum: char,
    download_url: &str,
) -> Value {
    serde_json::json!({
        "dshVersion": version,
        "sourceFingerprint": fingerprint.to_string().repeat(64),
        "archiveSha256": checksum.to_string().repeat(64),
        "archiveBytes": 1024,
        "downloadUrl": download_url
    })
}

#[test]
fn runtime_catalog_requires_https_and_integrity_metadata() {
    let directory = tempdir().unwrap();
    fs::write(
        directory.path().join(BUNDLED_RUNTIME_CATALOG),
        serde_json::to_vec(&serde_json::json!({
            "runtimes": [
                runtime_descriptor(
                    "0.1.0-rc.7",
                    'a',
                    'b',
                    "https://downloads.example/runtime.tar.gz"
                )
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let catalog = read_runtime_catalog(directory.path()).unwrap();
    let descriptor = &catalog.runtimes[0];

    assert_eq!(descriptor.archive_bytes, 1024);
    assert_eq!(descriptor.archive_sha256, "b".repeat(64));
}

#[test]
fn runtime_catalog_rejects_insecure_downloads() {
    let directory = tempdir().unwrap();
    fs::write(
        directory.path().join(BUNDLED_RUNTIME_CATALOG),
        serde_json::to_vec(&serde_json::json!({
            "runtimes": [
                runtime_descriptor(
                    "0.1.0-rc.7",
                    'a',
                    'b',
                    "http://downloads.example/runtime.tar.gz"
                )
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(read_runtime_catalog(directory.path())
        .unwrap_err()
        .contains("must use HTTPS"));
}

#[test]
fn runtime_catalog_selects_the_highest_matching_dsh_version() {
    let catalog = BundledDshRuntimeCatalog {
        runtimes: vec![
            serde_json::from_value(runtime_descriptor(
                "0.1.0-rc.7",
                'a',
                'b',
                "https://downloads.example/rc7.tar.gz",
            ))
            .unwrap(),
            serde_json::from_value(runtime_descriptor(
                "0.1.0-rc.8",
                'c',
                'd',
                "https://downloads.example/rc8.tar.gz",
            ))
            .unwrap(),
        ],
    };

    let exact =
        select_runtime_descriptor(&catalog, &dsh_version_requirement("0.1.0-rc.7").unwrap())
            .unwrap();
    let range = select_runtime_descriptor(
        &catalog,
        &VersionReq::parse(">=0.1.0-rc.7, <0.1.0").unwrap(),
    )
    .unwrap();

    assert_eq!(exact.dsh_version, Version::parse("0.1.0-rc.7").unwrap());
    assert_eq!(range.dsh_version, Version::parse("0.1.0-rc.8").unwrap());
}

#[test]
fn runtime_catalog_rejects_an_unsupported_dsh_version() {
    let catalog = BundledDshRuntimeCatalog {
        runtimes: vec![serde_json::from_value(runtime_descriptor(
            "0.1.0-rc.8",
            'a',
            'b',
            "https://downloads.example/rc8.tar.gz",
        ))
        .unwrap()],
    };

    let error =
        select_runtime_descriptor(&catalog, &dsh_version_requirement("0.1.0-rc.7").unwrap())
            .unwrap_err();

    assert!(error.contains("no managed DeepSeek Harness runtime"));
}

#[cfg(unix)]
#[test]
fn materialized_runtimes_keep_dsh_versions_isolated() {
    let directory = tempdir().unwrap();
    let node = directory.path().join("node");
    fs::write(
        &node,
        "#!/bin/sh\n\
         test \"$1\" = \"-p\"\n\
         test \"$2\" = \"process.versions.node\"\n\
         printf '24.1.0'\n",
    )
    .unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    for version in ["0.1.0-rc.7", "0.1.0-rc.8"] {
        let runtime = directory.path().join(version);
        let dsh = runtime.join("node_modules/@deepseek-ai/dsh");
        fs::create_dir_all(dsh.join("lib")).unwrap();
        fs::create_dir_all(runtime.join("plugins")).unwrap();
        fs::write(
            dsh.join("package.json"),
            serde_json::to_vec(&serde_json::json!({ "version": version })).unwrap(),
        )
        .unwrap();
        fs::write(dsh.join("lib/bin.js"), "").unwrap();
    }

    let rc7 = resolve_materialized_dsh_runtime(
        directory.path().to_path_buf(),
        node.clone(),
        &dsh_version_requirement("0.1.0-rc.7").unwrap(),
    )
    .unwrap();
    let rc8 = resolve_materialized_dsh_runtime(
        directory.path().to_path_buf(),
        node,
        &dsh_version_requirement("0.1.0-rc.8").unwrap(),
    )
    .unwrap();

    assert_eq!(rc7.version, Version::parse("0.1.0-rc.7").unwrap());
    assert!(rc7.root.ends_with("0.1.0-rc.7"));
    assert_eq!(rc8.version, Version::parse("0.1.0-rc.8").unwrap());
    assert!(rc8.root.ends_with("0.1.0-rc.8"));
}

#[test]
fn runtime_archive_hash_reports_bytes_and_checksum() {
    let directory = tempdir().unwrap();
    let archive = directory.path().join("runtime.tar.gz");
    fs::write(&archive, b"runtime").unwrap();

    let (checksum, bytes) = file_sha256(&archive).unwrap();

    assert_eq!(bytes, 7);
    assert_eq!(
        checksum,
        "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23"
    );
}
