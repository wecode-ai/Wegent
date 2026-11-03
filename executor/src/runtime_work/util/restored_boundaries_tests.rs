// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn normalized_restore_paths_cannot_discover_ancestor_git_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let checkout = directory.path().join("linked");
    let git_dir = directory.path().join("main/.git/worktrees/linked");
    let restores = checkout.join("executor-home/restored-workspaces");
    let task = restores.join("task-b");
    std::fs::create_dir_all(&git_dir).unwrap();
    std::fs::create_dir_all(restores.join("task-a")).unwrap();
    std::fs::create_dir_all(&task).unwrap();
    std::fs::write(
        checkout.join(".git"),
        format!("gitdir: {}\n", git_dir.display()),
    )
    .unwrap();
    let path = restores.join("task-a/../task-b");

    assert!(git_metadata_directories_with_boundary(&path, Some(&task)).is_none());
    assert_eq!(
        git_metadata_directories_with_boundary(&path, None)
            .unwrap()
            .0,
        checkout
    );
}
