// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn legacy(root: &Path) {
    fs::create_dir(root.join(".repository-locks")).unwrap();
    fs::write(root.join(".repository-locks/repo.lock"), "").unwrap();
    fs::write(root.join(".repository-publish.lock"), "").unwrap();
    fs::create_dir(root.join(".repository-tasks")).unwrap();
    fs::write(
        root.join(".repository-tasks/42.json"),
        br#"{"key":"demo-hash","name":"demo"}"#,
    )
    .unwrap();
}

#[test]
fn migration_preserves_bindings_and_repositories_and_is_repeatable() {
    let root = tempfile::tempdir().unwrap();
    legacy(root.path());
    fs::create_dir(root.path().join("demo-hash")).unwrap();
    fs::write(root.path().join("demo-hash/uncommitted"), "retain").unwrap();
    let old_binding = fs::read(root.path().join(".repository-tasks/42.json")).unwrap();
    assert_eq!(
        path(root.path(), Entry::Locks).unwrap(),
        root.path().join(".repository-locks")
    );
    migrate(root.path()).unwrap();
    migrate(root.path()).unwrap();
    assert_eq!(
        fs::read(root.path().join(".wegent/tasks/42.json")).unwrap(),
        old_binding
    );
    assert_eq!(
        fs::read_to_string(root.path().join("demo-hash/uncommitted")).unwrap(),
        "retain"
    );
    assert_eq!(
        path(root.path(), Entry::Locks).unwrap(),
        root.path().join(".wegent/locks")
    );
    assert!(!root.path().join(".repository-locks").exists());
    assert!(!root.path().join(".repository-publish.lock").exists());
    assert!(!root.path().join(".repository-tasks").exists());
}

#[test]
fn active_repository_or_publication_prevents_any_moves() {
    for name in [".repository-locks/repo.lock", ".repository-publish.lock"] {
        let root = tempfile::tempdir().unwrap();
        legacy(root.path());
        let lease = lock_file(&root.path().join(name)).unwrap();
        assert!(migrate(root.path()).unwrap_err().contains("active"));
        assert!(root.path().join(".repository-tasks/42.json").exists());
        assert!(root.path().join(".repository-locks/repo.lock").exists());
        assert!(!root.path().join(".wegent/locks").exists());
        drop(lease);
        migrate(root.path()).unwrap();
    }
}

#[test]
fn interrupted_migration_resumes_but_runtime_rejects_mixed_layout() {
    let root = tempfile::tempdir().unwrap();
    legacy(root.path());
    fs::create_dir(root.path().join(".wegent")).unwrap();
    fs::rename(
        root.path().join(".repository-locks"),
        root.path().join(".wegent/locks"),
    )
    .unwrap();
    assert!(path(root.path(), Entry::Tasks).is_err());
    migrate(root.path()).unwrap();
    assert!(path(root.path(), Entry::Tasks)
        .unwrap()
        .join("42.json")
        .exists());
}

#[test]
fn conflicting_layouts_do_not_overwrite_either_side() {
    let root = tempfile::tempdir().unwrap();
    legacy(root.path());
    fs::create_dir_all(root.path().join(".wegent/tasks")).unwrap();
    fs::write(root.path().join(".wegent/tasks/42.json"), "other binding").unwrap();
    assert!(migrate(root.path()).is_err());
    assert_eq!(
        fs::read_to_string(root.path().join(".wegent/tasks/42.json")).unwrap(),
        "other binding"
    );
    assert!(root.path().join(".repository-locks/repo.lock").exists());
}

#[cfg(unix)]
#[test]
fn metadata_symlinks_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".wegent")).unwrap();
    assert!(path(root.path(), Entry::Tasks).is_err());
    assert!(migrate(root.path()).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
