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
    std::os::windows::fs::symlink_dir(&first, &target)
        .expect("Windows test requires Developer Mode or symlink privileges");
    link_package(&second, &target).unwrap();
    assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "new");
    assert_eq!(fs::read_to_string(first.join("SKILL.md")).unwrap(), "old");
}
