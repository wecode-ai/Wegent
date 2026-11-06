// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn imports_once_and_never_dual_writes_legacy_manifest() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("manifest.json");
    let original =
        br#"{"version":1,"revision":7,"skills":{"old":{"managed":true}},"custom":{"keep":true}}"#;
    fs::write(&legacy, original).unwrap();
    let modified = fs::metadata(&legacy).unwrap().modified().unwrap();
    let current = ManagedCapabilityManifest::new(root.path().join(WORKBENCH_MANIFEST));
    let mut value = current.load().unwrap();
    assert_eq!(value["version"], 2);
    assert_eq!(value["revision"], 7);
    assert_eq!(value["custom"]["keep"], true);
    value["skills"]["new"] = json!({"managed":true,"store_path":"shared-package"});
    current.save_with_revision_bump(value).unwrap();
    assert_eq!(fs::read(&legacy).unwrap(), original);
    assert_eq!(fs::metadata(&legacy).unwrap().modified().unwrap(), modified);
    assert_eq!(current.load().unwrap()["revision"], 8);
    fs::write(&legacy, b"not valid JSON anymore").unwrap();
    assert_eq!(current.load().unwrap()["skills"]["old"]["managed"], true);
    assert_eq!(current.load().unwrap()["skills"]["new"]["managed"], true);
}

#[test]
fn creates_only_v2_when_no_legacy_manifest_exists() {
    let root = tempfile::tempdir().unwrap();
    let current = ManagedCapabilityManifest::new(root.path().join(WORKBENCH_MANIFEST));
    assert_eq!(current.load().unwrap()["version"], 2);
    assert!(!root.path().join("manifest.json").exists());
}

#[test]
fn invalid_legacy_is_preserved_and_not_silently_replaced() {
    for bytes in ["invalid JSON", "[]", r#"{"version":9}"#, r#"{"skills":[]}"#] {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("manifest.json");
        fs::write(&legacy, bytes).unwrap();
        let current = ManagedCapabilityManifest::new(root.path().join(WORKBENCH_MANIFEST));
        assert!(current.load().is_err());
        assert!(!current.path.exists());
        assert_eq!(fs::read_to_string(legacy).unwrap(), bytes);
    }
}

#[test]
fn invalid_existing_v2_never_falls_back_to_legacy() {
    for bytes in ["invalid JSON", "{}", r#"{"version":1}"#, r#"{"version":3}"#] {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("manifest.json"), r#"{"version":1}"#).unwrap();
        let current = ManagedCapabilityManifest::new(root.path().join(WORKBENCH_MANIFEST));
        fs::write(&current.path, bytes).unwrap();
        assert!(current.load().is_err());
        assert!(current.save(default_manifest()).is_err());
        assert_eq!(fs::read_to_string(&current.path).unwrap(), bytes);
    }
}

#[test]
fn explicit_custom_manifest_is_not_renamed_or_imported() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("manifest.json"), "invalid JSON").unwrap();
    let custom = ManagedCapabilityManifest::new(root.path().join("custom.json"));
    assert_eq!(custom.load().unwrap()["version"], 1);
    custom.save(default_manifest()).unwrap();
    assert!(custom.path.is_file());
    assert!(!root.path().join(WORKBENCH_MANIFEST).exists());
    assert_eq!(
        fs::read_to_string(root.path().join("manifest.json")).unwrap(),
        "invalid JSON"
    );
}

#[test]
fn explicit_legacy_manifest_path_remains_explicit() {
    let root = tempfile::tempdir().unwrap();
    let legacy = ManagedCapabilityManifest::new(root.path().join("manifest.json"));
    legacy.save(default_manifest()).unwrap();
    assert_eq!(legacy.load().unwrap()["version"], 1);
    assert!(!root.path().join(WORKBENCH_MANIFEST).exists());
}

#[test]
fn concurrent_first_reads_import_one_complete_document() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("manifest.json");
    fs::write(&legacy, br#"{"version":1,"revision":12}"#).unwrap();
    let path = root.path().join(WORKBENCH_MANIFEST);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                ManagedCapabilityManifest::new(path).load().unwrap()
            })
        })
        .collect();
    for thread in threads {
        let value = thread.join().unwrap();
        assert_eq!(value["version"], 2);
        assert_eq!(value["revision"], 12);
    }
    assert_eq!(
        fs::read_to_string(legacy).unwrap(),
        r#"{"version":1,"revision":12}"#
    );
}

#[cfg(unix)]
#[test]
fn rejects_a_v2_alias_of_legacy_without_modifying_either() {
    for hard_link in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("manifest.json");
        fs::write(&legacy, br#"{"version":1}"#).unwrap();
        let current = ManagedCapabilityManifest::new(root.path().join(WORKBENCH_MANIFEST));
        if hard_link {
            fs::hard_link(&legacy, &current.path).unwrap();
        } else {
            std::os::unix::fs::symlink(&legacy, &current.path).unwrap();
        }
        assert!(current.load().is_err());
        assert!(current.save(default_manifest()).is_err());
        assert_eq!(fs::read_to_string(legacy).unwrap(), r#"{"version":1}"#);
    }
}
