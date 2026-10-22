// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in entries {
        archive
            .start_file(*name, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

#[test]
fn root_resolution_uses_user_home_and_absolute_overrides() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home/user");
    let explicit = root.path().join("explicit");
    assert_eq!(
        resolve_workbench_root(Some(PathBuf::new()), Some(home.clone())).unwrap(),
        home.join(".wegent/workbench")
    );
    assert_eq!(
        resolve_workbench_root(None, Some(home.clone())).unwrap(),
        home.join(".wegent/workbench")
    );
    assert_eq!(
        resolve_workbench_root(Some(explicit.clone()), Some(home)).unwrap(),
        explicit
    );
    assert_eq!(
        resolve_workbench_root(Some(explicit.clone()), None).unwrap(),
        explicit
    );
    assert!(resolve_workbench_root(None, None).is_err());
    assert!(resolve_workbench_root(Some(PathBuf::from("relative")), None).is_err());
    assert!(resolve_workbench_root(Some(root.path().join("nested/../other")), None).is_err());
}

#[test]
fn published_skill_is_addressed_by_archive_bytes_and_reused_without_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[
        ("wrapper/SKILL.md", "first"),
        ("wrapper/scripts/run.sh", "echo first"),
    ]);
    let first = publish_skill_archive(root.path(), &bytes, None).unwrap();
    assert_eq!(
        first.path,
        root.path()
            .join("shared/skills")
            .join(&archive_hash(&bytes)[7..])
    );
    let modified = fs::metadata(first.path.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    let second = publish_skill_archive(root.path(), &bytes, Some(&first.archive_hash)).unwrap();
    assert_eq!(first.path, second.path);
    assert_eq!(
        modified,
        fs::metadata(second.path.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap()
    );
    assert_eq!(
        fs::read_to_string(first.path.join("SKILL.md")).unwrap(),
        "first"
    );
}

#[test]
fn skill_packages_preserve_server_versions_and_reject_invalid_identifiers() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[("SKILL.md", "original")]);
    assert!(publish_skill_archive(root.path(), &bytes, Some("sha256:../invalid")).is_err());
    assert!(!root.path().join("shared").exists());
    let version = format!("sha256:{}", "0".repeat(64));
    let package = publish_skill_archive(root.path(), &bytes, Some(&version)).unwrap();
    assert_eq!(package.archive_hash, version);
    let metadata = fs::read_to_string(
        root.path()
            .join("shared/metadata")
            .join(format!("skills-{}.json", "0".repeat(64))),
    )
    .unwrap();
    assert!(!metadata.contains("files_hash"));
    let reused = publish_skill_archive(
        root.path(),
        &zip(&[("SKILL.md", "different")]),
        Some(&version),
    )
    .unwrap();
    assert_eq!(reused.path, package.path);
    assert_eq!(
        fs::read_to_string(package.path.join("SKILL.md")).unwrap(),
        "original"
    );
}

#[test]
fn unsafe_duplicate_and_ambiguous_packages_never_publish() {
    for entries in [
        vec![("SKILL.md", "ok"), ("../outside", "bad")],
        vec![("SKILL.md", "ok"), ("/absolute", "bad")],
        vec![("SKILL.md", "ok"), ("a\\b", "bad")],
        vec![("SKILL.md", "ok"), ("skill.md", "bad")],
        vec![("one/SKILL.md", "one"), ("two/SKILL.md", "two")],
    ] {
        let root = tempfile::tempdir().unwrap();
        assert!(publish_skill_archive(root.path(), &zip(&entries), None).is_err());
        assert!(!root.path().join("shared/skills").exists());
    }
}

#[test]
fn concurrent_publishers_converge_to_one_package() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[("SKILL.md", "shared")]);
    let handles = (0..4)
        .map(|_| {
            let root = root.path().to_owned();
            let bytes = bytes.clone();
            std::thread::spawn(move || publish_skill_archive(&root, &bytes, None).unwrap().path)
        })
        .collect::<Vec<_>>();
    let paths = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(paths.len(), 1);
    assert_eq!(
        fs::read_dir(root.path().join("shared/skills"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn plugin_archive_retains_original_manifest_without_runtime_cache_changes() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[
        ("plugin/.claude-plugin/plugin.json", "{\"name\":\"demo\"}"),
        ("plugin/hooks/run.sh", "echo hook"),
    ]);
    let package = publish_plugin_archive(root.path(), &bytes, None).unwrap();
    assert!(package.path.join(".claude-plugin/plugin.json").exists());
    assert!(!package.path.join(".codex-plugin/plugin.json").exists());
    assert!(publish_plugin_archive(root.path(), &bytes, None).is_ok());
}

#[test]
fn corrupt_managed_plugin_is_repaired_and_healthy_package_is_never_rewritten() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[
        (".claude-plugin/plugin.json", "{\"name\":\"demo\"}"),
        ("payload.txt", "verified"),
    ]);
    let package = publish_plugin_archive(root.path(), &bytes, None).unwrap();
    let metadata = root
        .path()
        .join("shared/metadata")
        .join(format!("plugins-{}.json", &package.archive_hash[7..]));
    let original_record = fs::read(&metadata).unwrap();
    let original_modified = fs::metadata(package.path.join("payload.txt"))
        .unwrap()
        .modified()
        .unwrap();
    publish_plugin_archive(root.path(), &bytes, Some(&package.archive_hash)).unwrap();
    assert_eq!(
        fs::metadata(package.path.join("payload.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        original_modified
    );
    assert_eq!(fs::read(&metadata).unwrap(), original_record);
    fs::write(package.path.join("payload.txt"), "corrupt").unwrap();
    let repaired =
        publish_plugin_archive(root.path(), &bytes, Some(&package.archive_hash)).unwrap();
    assert_eq!(repaired.path, package.path);
    assert_eq!(
        fs::read_to_string(package.path.join("payload.txt")).unwrap(),
        "verified"
    );
    verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();
    let quarantine = fs::read_dir(root.path().join("shared/quarantine"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read_to_string(quarantine.join("package/payload.txt")).unwrap(),
        "corrupt"
    );
    assert_eq!(
        fs::read(quarantine.join("record.json")).unwrap(),
        original_record
    );
}

#[test]
fn failed_repair_validation_preserves_current_package_and_record() {
    let root = tempfile::tempdir().unwrap();
    let package = plugin_fixture(root.path());
    let record = root
        .path()
        .join("shared/metadata")
        .join(format!("plugins-{}.json", &package.archive_hash[7..]));
    let original_record = fs::read(&record).unwrap();
    let source = package.path.join("README.md");
    fs::write(&source, "corrupt but retained").unwrap();
    let _lock = lock_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();
    assert!(repair_plugin_package(
        root.path(),
        b"invalid zip",
        &package.archive_hash,
        &package.path,
        &record
    )
    .is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "corrupt but retained");
    assert_eq!(fs::read(&record).unwrap(), original_record);
    assert_eq!(
        fs::read_dir(root.path().join("shared/quarantine"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn corrupt_unmanaged_hash_directory_is_not_replaced() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[(".claude-plugin/plugin.json", "{\"name\":\"demo\"}")]);
    let destination = root
        .path()
        .join("shared/plugins")
        .join(&archive_hash(&bytes)[7..]);
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("user-data"), "keep").unwrap();
    assert!(publish_plugin_archive(root.path(), &bytes, None).is_err());
    assert_eq!(
        fs::read_to_string(destination.join("user-data")).unwrap(),
        "keep"
    );
}

#[test]
#[cfg(unix)]
fn plugin_repair_rejects_symbolic_store_paths_and_preserves_outside_data() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let bytes = zip(&[(".claude-plugin/plugin.json", "{\"name\":\"demo\"}")]);
    fs::create_dir_all(root.path().join("shared")).unwrap();
    fs::write(outside.path().join("user-data"), "keep").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("shared/plugins")).unwrap();
    assert!(publish_plugin_archive(root.path(), &bytes, None).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("user-data")).unwrap(),
        "keep"
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
}

fn plugin_fixture(root: &Path) -> PublishedPackage {
    publish_plugin_archive(
        root,
        &zip(&[
            ("plugin/.claude-plugin/plugin.json", "{\"name\":\"demo\"}"),
            (
                "plugin/scripts/auth_provider.py",
                "print('verified source')",
            ),
            ("plugin/README.md", "verified documentation"),
        ]),
        None,
    )
    .unwrap()
}

fn add_legacy_bytecode(package: &PublishedPackage) {
    let cache = package.path.join("scripts/__pycache__/nested");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("auth_provider.cpython-312.pyc"), "old bytecode").unwrap();
    fs::write(package.path.join("scripts/legacy.pyc"), "old bytecode").unwrap();
}

#[test]
fn published_plugin_removes_generated_bytecode_before_verification() {
    let root = tempfile::tempdir().unwrap();
    let package = plugin_fixture(root.path());
    let record_path = root
        .path()
        .join("shared/metadata")
        .join(format!("plugins-{}.json", &package.archive_hash[7..]));
    let record = fs::read(&record_path).unwrap();
    add_legacy_bytecode(&package);

    let verified =
        verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();

    assert_eq!(verified.path, package.path);
    assert!(!package.path.join("scripts/__pycache__").exists());
    assert!(!package.path.join("scripts/legacy.pyc").exists());
    assert_eq!(fs::read(record_path).unwrap(), record);
    assert_eq!(
        fs::read_to_string(package.path.join("scripts/auth_provider.py")).unwrap(),
        "print('verified source')"
    );
    assert_eq!(
        fs::read_to_string(package.path.join("README.md")).unwrap(),
        "verified documentation"
    );
}

#[test]
fn legacy_bytecode_does_not_hide_modified_plugin_sources() {
    let root = tempfile::tempdir().unwrap();
    let package = plugin_fixture(root.path());
    add_legacy_bytecode(&package);
    fs::write(package.path.join("scripts/auth_provider.py"), "modified").unwrap();

    let result = verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash);

    assert!(result.unwrap_err().contains("integrity check failed"));
    assert!(package.path.join("scripts/legacy.pyc").exists());
    assert!(package.path.join("scripts/__pycache__").exists());
}

#[test]
fn published_plugin_keeps_bytecode_already_in_the_verified_archive() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[
        ("plugin/.claude-plugin/plugin.json", "{\"name\":\"demo\"}"),
        ("plugin/scripts/precompiled.pyc", "verified bytecode"),
    ]);
    let package = publish_plugin_archive(root.path(), &bytes, None).unwrap();

    verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();

    assert_eq!(
        fs::read_to_string(package.path.join("scripts/precompiled.pyc")).unwrap(),
        "verified bytecode"
    );
}

fn compiled_plugin_fixture(root: &Path) -> PublishedPackage {
    publish_plugin_archive(
        root,
        &zip(&[
            ("plugin/.claude-plugin/plugin.json", "{\"name\":\"demo\"}"),
            ("plugin/scripts/precompiled.pyc", "verified bytecode"),
            (
                "plugin/scripts/__pycache__/canonical.pyc",
                "verified cache bytecode",
            ),
        ]),
        None,
    )
    .unwrap()
}

#[test]
fn legacy_cache_recovery_preserves_all_published_bytecode_paths() {
    let root = tempfile::tempdir().unwrap();
    let package = compiled_plugin_fixture(root.path());
    add_legacy_bytecode(&package);

    verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();

    assert_eq!(
        fs::read_to_string(package.path.join("scripts/precompiled.pyc")).unwrap(),
        "verified bytecode"
    );
    assert_eq!(
        fs::read_to_string(package.path.join("scripts/__pycache__/canonical.pyc")).unwrap(),
        "verified cache bytecode"
    );
    assert!(!package.path.join("scripts/legacy.pyc").exists());
    assert!(!package.path.join("scripts/__pycache__/nested").exists());
}

#[test]
fn legacy_records_never_delete_ambiguous_bytecode_or_caches() {
    let root = tempfile::tempdir().unwrap();
    let package = compiled_plugin_fixture(root.path());
    let record_path = root
        .path()
        .join("shared/metadata")
        .join(format!("plugins-{}.json", &package.archive_hash[7..]));
    let mut record: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    record
        .as_object_mut()
        .unwrap()
        .remove("published_bytecode_paths");
    fs::write(&record_path, record.to_string()).unwrap();
    add_legacy_bytecode(&package);

    let result = verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash);

    assert!(result.unwrap_err().contains("integrity check failed"));
    assert!(package.path.join("scripts/legacy.pyc").exists());
    assert!(package.path.join("scripts/__pycache__/nested").exists());
    assert_eq!(
        fs::read_to_string(package.path.join("scripts/precompiled.pyc")).unwrap(),
        "verified bytecode"
    );
    assert_eq!(
        fs::read_to_string(package.path.join("scripts/__pycache__/canonical.pyc")).unwrap(),
        "verified cache bytecode"
    );
}

#[test]
fn legacy_records_recover_only_when_the_original_hash_proves_cache_ownership() {
    let root = tempfile::tempdir().unwrap();
    let package = plugin_fixture(root.path());
    let record_path = root
        .path()
        .join("shared/metadata")
        .join(format!("plugins-{}.json", &package.archive_hash[7..]));
    let mut record: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    record
        .as_object_mut()
        .unwrap()
        .remove("published_bytecode_paths");
    fs::write(&record_path, record.to_string()).unwrap();
    let record_bytes = fs::read(&record_path).unwrap();
    add_legacy_bytecode(&package);

    verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash).unwrap();

    assert_eq!(fs::read(&record_path).unwrap(), record_bytes);
    assert!(!package.path.join("scripts/legacy.pyc").exists());
    assert!(!package.path.join("scripts/__pycache__").exists());
}

#[test]
fn concurrent_verifiers_recover_a_package_with_legacy_bytecode() {
    let root = tempfile::tempdir().unwrap();
    let package = plugin_fixture(root.path());
    add_legacy_bytecode(&package);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let handles = (0..4)
        .map(|_| {
            let root = root.path().to_owned();
            let hash = package.archive_hash.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                verify_published_package(&root, PackageKind::Plugin, &hash)
                    .unwrap()
                    .path
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        assert_eq!(handle.join().unwrap(), package.path);
    }
    assert!(!package.path.join("scripts/__pycache__").exists());
}

#[test]
#[cfg(unix)]
fn bytecode_cache_symlinks_are_rejected_without_touching_their_targets() {
    for name in [
        "scripts/__pycache__",
        "scripts/legacy.pyc",
        "scripts/__pycache__/auth_provider.pyc",
    ] {
        let root = tempfile::tempdir().unwrap();
        let package = plugin_fixture(root.path());
        let outside = root.path().join("outside");
        fs::write(&outside, "must remain unchanged").unwrap();
        let link = package.path.join(name);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let result =
            verify_published_package(root.path(), PackageKind::Plugin, &package.archive_hash);

        assert!(result.unwrap_err().contains("symbolic links"));
        assert!(link.is_symlink());
        assert_eq!(
            fs::read_to_string(outside).unwrap(),
            "must remain unchanged"
        );
    }
}

#[test]
#[cfg(unix)]
fn relative_links_switch_without_mutating_previous_package() {
    let root = tempfile::tempdir().unwrap();
    let first = publish_skill_archive(root.path(), &zip(&[("SKILL.md", "v1")]), None).unwrap();
    let second = publish_skill_archive(root.path(), &zip(&[("SKILL.md", "v2")]), None).unwrap();
    let target = root.path().join("agents/group/demo/skills/example");
    link_package(&first.path, &target).unwrap();
    assert!(fs::read_link(&target).unwrap().is_relative());
    link_package(&second.path, &target).unwrap();
    assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "v2");
    assert_eq!(
        fs::read_to_string(first.path.join("SKILL.md")).unwrap(),
        "v1"
    );
}

#[test]
#[cfg(unix)]
fn published_symlink_is_never_followed_or_replaced() {
    let root = tempfile::tempdir().unwrap();
    let bytes = zip(&[("SKILL.md", "safe")]);
    let destination = root
        .path()
        .join("shared/skills")
        .join(&archive_hash(&bytes)[7..]);
    let other = root.path().join("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("SKILL.md"), "user data").unwrap();
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&other, &destination).unwrap();
    assert!(publish_skill_archive(root.path(), &bytes, None).is_err());
    assert_eq!(
        fs::read_to_string(other.join("SKILL.md")).unwrap(),
        "user data"
    );
}

#[test]
fn link_publication_never_replaces_an_existing_real_directory() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(source.join("SKILL.md"), "new").unwrap();
    fs::write(target.join("SKILL.md"), "original").unwrap();
    assert!(link_package(&source, &target).is_err());
    assert!(!target.is_symlink());
    assert_eq!(
        fs::read_to_string(target.join("SKILL.md")).unwrap(),
        "original"
    );
}

#[test]
#[cfg(windows)]
fn windows_replaces_an_existing_directory_link_under_an_idle_caller() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let target = root.path().join("entry");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("SKILL.md"), "old").unwrap();
    fs::write(second.join("SKILL.md"), "new").unwrap();
    crate::directory_link::create(&first, &target).unwrap();
    link_package(&second, &target).unwrap();
    assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "new");
    assert_eq!(fs::read_to_string(first.join("SKILL.md")).unwrap(), "old");
}
