// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::Barrier;

#[test]
fn cleanup_survives_removed_source_worktree_and_recovers_failed_record() {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("repository");
    super::tests::initialize_repository(&repository);
    let source = root.path().join("source");
    super::tests::run_git(
        &repository,
        &["worktree", "add", "--detach", source.to_str().unwrap()],
    );
    let manager = WorktreeManager::new(root.path().join("runtime-work/worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.path().join("managed").display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let record = manager.prepare(&source, "task-1", None, false).unwrap();
    let path = Path::new(&record.path);
    super::tests::run_git(
        &repository,
        &["worktree", "remove", source.to_str().unwrap()],
    );
    let mut state = manager.load();
    let failed = state.records.get_mut(&normalized_path_key(path)).unwrap();
    failed.state = STATE_FAILED.to_owned();
    failed.last_error = Some("worktree_source_missing".to_owned());
    manager.save(&state).unwrap();

    let listed = manager.list(&[]).unwrap();
    assert_eq!(listed[0].0.state, STATE_ACTIVE);
    assert_eq!(listed[0].0.last_error, None);
    manager.delete(path, false).unwrap();
    assert!(!path.exists());
}

#[test]
fn cleanup_still_rejects_worktree_from_another_repository() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let other = root.path().join("other");
    super::tests::initialize_repository(&source);
    super::tests::initialize_repository(&other);
    let manager = WorktreeManager::new(root.path().join("runtime-work/worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.path().join("managed").display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let record = manager.prepare(&source, "task-1", None, false).unwrap();
    super::tests::run_git(&source, &["worktree", "remove", &record.path]);
    super::tests::run_git(&other, &["worktree", "add", "--detach", &record.path]);

    assert!(manager
        .delete(Path::new(&record.path), false)
        .unwrap_err()
        .contains("another repository"));
    assert!(Path::new(&record.path).exists());
}

#[test]
fn concurrent_state_writes_keep_temporary_files_independent() {
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join("runtime-work/worktrees.json");
    let barrier = Barrier::new(8);
    let failures = std::thread::scope(|scope| {
        let writers = (0..8)
            .map(|_| {
                let state_path = &state_path;
                let barrier = &barrier;
                scope.spawn(move || {
                    let manager = WorktreeManager::new(state_path.clone());
                    let state = initial_worktree_state(state_path);
                    let mut failures = Vec::new();
                    for _ in 0..16 {
                        barrier.wait();
                        if let Err(error) = manager.save(&state) {
                            failures.push(error);
                        }
                    }
                    failures
                })
            })
            .collect::<Vec<_>>();
        writers
            .into_iter()
            .flat_map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>()
    });

    assert!(
        failures.is_empty(),
        "concurrent writes failed: {failures:?}"
    );
    serde_json::from_slice::<WorktreeState>(&fs::read(&state_path).unwrap()).unwrap();
    let files = fs::read_dir(state_path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(files, ["worktrees.json"]);
}
