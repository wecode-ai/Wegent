use super::*;
use std::io::Write;
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
            "profile":"test",
            "webUrl":"http://127.0.0.1:3080/"
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
    };

    let output = prepare_instance_bundle(&installation, directory.path(), true).unwrap();
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
    };

    let output = prepare_instance_bundle(&installation, directory.path(), true).unwrap();
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
#[test]
fn runtime_descriptor_requires_https_and_integrity_metadata() {
    let directory = tempdir().unwrap();
    fs::write(
        directory.path().join(BUNDLED_RUNTIME_METADATA),
        serde_json::to_vec(&serde_json::json!({
            "sourceFingerprint": "a".repeat(64),
            "archiveSha256": "b".repeat(64),
            "archiveBytes": 1024,
            "downloadUrl": "https://downloads.example/runtime.tar.gz"
        }))
        .unwrap(),
    )
    .unwrap();

    let descriptor = read_runtime_descriptor(directory.path()).unwrap();

    assert_eq!(descriptor.archive_bytes, 1024);
    assert_eq!(descriptor.archive_sha256, "b".repeat(64));
}

#[test]
fn runtime_descriptor_rejects_insecure_downloads() {
    let directory = tempdir().unwrap();
    fs::write(
        directory.path().join(BUNDLED_RUNTIME_METADATA),
        serde_json::to_vec(&serde_json::json!({
            "sourceFingerprint": "a".repeat(64),
            "archiveSha256": "b".repeat(64),
            "archiveBytes": 1024,
            "downloadUrl": "http://downloads.example/runtime.tar.gz"
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(read_runtime_descriptor(directory.path())
        .unwrap_err()
        .contains("must use HTTPS"));
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
