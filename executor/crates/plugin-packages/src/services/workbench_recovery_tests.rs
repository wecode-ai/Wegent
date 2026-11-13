// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn archive() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, text) in [
        (
            ".codex-plugin/plugin.json",
            r#"{"name":"demo","version":"1.0.0"}"#,
        ),
        ("payload.txt", "verified source"),
    ] {
        writer
            .start_file(name, zip::write::FileOptions::default())
            .unwrap();
        writer.write_all(text.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn fixture(root: &Path) -> (Vec<u8>, RecoveryPaths) {
    let bytes = archive();
    let hash = archive_hash(&bytes);
    let package = publish_plugin_archive(root, &bytes, Some(&hash)).unwrap();
    fs::write(package.path.join("payload.txt"), "corrupt source").unwrap();
    (bytes, RecoveryPaths::new(root, &hash))
}

fn retained(paths: &RecoveryPaths, prefix: &str) -> Vec<PathBuf> {
    fs::read_dir(&paths.history)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(prefix)
        })
        .collect()
}

#[test]
fn checked_download_repairs_receipted_package_and_preserves_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    let before = fs::read(&paths.metadata).unwrap();
    let recovered = prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |path| {
        assert_eq!(
            fs::read_to_string(path.join("payload.txt")).unwrap(),
            "verified source"
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(recovered.archive_hash, paths.hash);
    assert_eq!(
        fs::read_to_string(recovered.path.join("payload.txt")).unwrap(),
        "verified source"
    );
    assert_eq!(fs::read(&paths.metadata).unwrap(), before);
    let backups = retained(&paths, "recovered-");
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read_to_string(backups[0].join("package/payload.txt")).unwrap(),
        "corrupt source"
    );
    assert_eq!(fs::read(backups[0].join("metadata.json")).unwrap(), before);
    assert!(!paths.pending.exists());
}

#[test]
fn healthy_package_is_reused_without_backups_or_revalidation_of_download() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive();
    let hash = archive_hash(&bytes);
    let first = prepare_plugin_archive(root.path(), &bytes, Some(&hash), |_| Ok(())).unwrap();
    let second = prepare_plugin_archive(root.path(), &bytes, Some(&hash), |_| {
        panic!("healthy cache must be reused")
    })
    .unwrap();
    assert_eq!(first.path, second.path);
    assert!(!root.path().join("shared/recovery").exists());
}

#[test]
fn unchecked_or_wrong_download_never_replaces_corrupt_package() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    assert!(prepare_plugin_archive(root.path(), &bytes, None, |_| Ok(())).is_err());
    assert!(
        prepare_plugin_archive(root.path(), b"untrusted bytes", Some(&paths.hash), |_| Ok(
            ()
        ))
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(paths.package.join("payload.txt")).unwrap(),
        "corrupt source"
    );
    assert!(!paths.history.exists());
}

#[test]
fn invalid_staged_identity_never_moves_existing_package() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    let error = prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |_| {
        Err("Wrong plugin identity".into())
    });
    assert!(
        matches!(error, Err(PackageRecoveryError::Invalid(message)) if message == "Wrong plugin identity")
    );
    assert_eq!(
        fs::read_to_string(paths.package.join("payload.txt")).unwrap(),
        "corrupt source"
    );
    assert!(!paths.history.exists());
}

#[test]
fn unreceipted_directory_is_not_adopted_or_quarantined() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    fs::remove_file(&paths.metadata).unwrap();
    assert!(prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |_| Ok(())).is_err());
    assert_eq!(
        fs::read_to_string(paths.package.join("payload.txt")).unwrap(),
        "corrupt source"
    );
    assert!(!paths.history.exists());
}

#[test]
fn active_preparation_prevents_repair_until_its_reader_is_released() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive();
    let hash = archive_hash(&bytes);
    publish_plugin_archive(root.path(), &bytes, Some(&hash)).unwrap();
    let reader = read_plugin_package(root.path(), &hash).unwrap();
    fs::write(reader.path.join("payload.txt"), "concurrent mutation").unwrap();
    assert!(matches!(
        prepare_plugin_archive(root.path(), &bytes, Some(&hash), |_| Ok(())),
        Err(PackageRecoveryError::Busy)
    ));
    assert_eq!(
        fs::read_to_string(reader.path.join("payload.txt")).unwrap(),
        "concurrent mutation"
    );
    drop(reader);
    let repaired = prepare_plugin_archive(root.path(), &bytes, Some(&hash), |_| Ok(())).unwrap();
    assert_eq!(
        fs::read_to_string(repaired.path.join("payload.txt")).unwrap(),
        "verified source"
    );
}

#[test]
fn legacy_receipt_without_file_hash_can_be_reconstructed_from_checked_archive() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    fs::write(
        &paths.metadata,
        format!(r#"{{"archive_hash":"{}"}}"#, paths.hash),
    )
    .unwrap();
    let package =
        prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |_| Ok(())).unwrap();
    assert_eq!(package.archive_hash, paths.hash);
    assert!(
        read_package_record(root.path(), PackageKind::Plugin, &paths.hash)
            .unwrap()
            .files_hash
            .is_some()
    );
}

fn prepare_pending(paths: &RecoveryPaths, bytes: &[u8]) {
    let stage = tempfile::tempdir_in(paths.root.join("shared/staging")).unwrap();
    extract_archive(bytes, stage.path(), PackageKind::Plugin).unwrap();
    let replacement = PackageRecord {
        archive_hash: paths.hash.clone(),
        files_hash: Some(files_hash(stage.path()).unwrap()),
        published_bytecode_paths: Some(bytecode_paths(stage.path()).unwrap()),
    };
    let metadata = serde_json::to_vec(&replacement).unwrap();
    let record = RecoveryRecord {
        archive_hash: paths.hash.clone(),
        before_files_hash: files_hash(&paths.package).unwrap(),
        before_metadata_hash: metadata_hash(&paths.metadata).unwrap(),
        after_files_hash: replacement.files_hash.unwrap(),
        after_metadata_hash: archive_hash(&metadata),
    };
    prepare_journal(paths, stage.path(), &metadata, &record).unwrap();
}

fn interrupt_publication(paths: &RecoveryPaths, completed_moves: usize) {
    let moves = [
        (paths.package.clone(), paths.original_package()),
        (paths.metadata.clone(), paths.original_metadata()),
        (
            paths.pending.join("replacement.json"),
            paths.metadata.clone(),
        ),
        (paths.pending.join("replacement"), paths.package.clone()),
    ];
    for (source, target) in moves.into_iter().take(completed_moves) {
        fs::rename(source, target).unwrap();
    }
}

#[test]
fn interrupted_publication_restores_both_original_entries_before_retry() {
    for completed in 0..4 {
        let root = tempfile::tempdir().unwrap();
        let (bytes, paths) = fixture(root.path());
        let before = fs::read(&paths.metadata).unwrap();
        prepare_pending(&paths, &bytes);
        interrupt_publication(&paths, completed);
        assert!(read_plugin_package(root.path(), &paths.hash).is_err());
        assert_eq!(
            fs::read_to_string(paths.package.join("payload.txt")).unwrap(),
            "corrupt source"
        );
        assert_eq!(fs::read(&paths.metadata).unwrap(), before);
        assert_eq!(retained(&paths, "rolled-back-").len(), 1);
        let package =
            prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read_to_string(package.path.join("payload.txt")).unwrap(),
            "verified source"
        );
    }
}

#[test]
fn completed_publication_is_finalized_after_interruption_without_another_download() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    prepare_pending(&paths, &bytes);
    interrupt_publication(&paths, 4);
    let package = read_plugin_package(root.path(), &paths.hash).unwrap();
    assert_eq!(
        fs::read_to_string(package.path.join("payload.txt")).unwrap(),
        "verified source"
    );
    assert_eq!(retained(&paths, "recovered-").len(), 1);
    assert!(!paths.pending.exists());
}

#[test]
fn conflicting_recovery_target_and_snapshots_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    prepare_pending(&paths, &bytes);
    interrupt_publication(&paths, 1);
    fs::create_dir(&paths.package).unwrap();
    fs::write(paths.package.join("user-data.txt"), "preserve user data").unwrap();
    assert!(read_plugin_package(root.path(), &paths.hash).is_err());
    assert_eq!(
        fs::read_to_string(paths.package.join("user-data.txt")).unwrap(),
        "preserve user data"
    );
    assert_eq!(
        fs::read_to_string(paths.original_package().join("payload.txt")).unwrap(),
        "corrupt source"
    );
    assert!(paths.pending.join("journal.json").exists());
}

#[test]
fn invalid_recovery_identity_never_moves_any_entry() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    prepare_pending(&paths, &bytes);
    let file = paths.pending.join("journal.json");
    let mut record: RecoveryRecord = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    record.archive_hash = format!("sha256:{}", "0".repeat(64));
    fs::write(file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(read_plugin_package(root.path(), &paths.hash).is_err());
    assert_eq!(
        fs::read_to_string(paths.package.join("payload.txt")).unwrap(),
        "corrupt source"
    );
    assert!(paths.pending.join("replacement/payload.txt").exists());
}

#[cfg(unix)]
#[test]
fn package_links_and_their_external_targets_are_not_repaired() {
    let root = tempfile::tempdir().unwrap();
    let (bytes, paths) = fixture(root.path());
    let outside = root.path().join("outside");
    fs::write(&outside, "external user data").unwrap();
    std::os::unix::fs::symlink(&outside, paths.package.join("outside-link")).unwrap();
    assert!(prepare_plugin_archive(root.path(), &bytes, Some(&paths.hash), |_| Ok(())).is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "external user data");
    assert!(!paths.history.exists());
}
