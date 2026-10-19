// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::Barrier;

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
