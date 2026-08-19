use super::*;
use std::io::Write;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

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
    write_archive(&archive, &manifest("0.1.0-rc.7"));

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
    let requirement = dsh_version_requirement("0.1.0-rc.7").unwrap();

    assert!(requirement.matches(&Version::parse("0.1.0-rc.7").unwrap()));
    assert!(!requirement.matches(&Version::parse("0.1.0-rc.8").unwrap()));
}

#[test]
fn manifest_rejects_install_package_escape() {
    let mut parsed: HarnessAppManifest = serde_json::from_str(&manifest("0.1.0-rc.7")).unwrap();
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
        manifest: serde_json::from_str(&manifest("0.1.0-rc.7")).unwrap(),
        package_path: package.display().to_string(),
        sha256: "hash".to_string(),
        model_key: Some("model".to_string()),
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
