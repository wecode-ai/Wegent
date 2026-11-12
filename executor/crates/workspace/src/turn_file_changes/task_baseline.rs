// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{git_output, GitTreeSnapshot};
use sha2::{Digest, Sha256};
use std::path::Path;

/// A private ref pins the first prepared tree across turns, branch changes,
/// executor restarts, and Git GC. Deleting the task repository removes it.
pub(super) fn load_or_create(
    workspace: &Path,
    task_id: i64,
    before: &GitTreeSnapshot,
) -> Result<GitTreeSnapshot, ()> {
    let scope = format!(
        "{:x}",
        Sha256::digest(workspace.to_string_lossy().as_bytes())
    );
    let reference = format!("refs/wegent/task-file-changes/{task_id}/{scope}");
    if let Some(tree) = read(workspace, &reference)? {
        return Ok(tree);
    }
    // Empty old-value is an atomic create-only assertion, including SHA-256 repos.
    if git_output(
        workspace,
        ["update-ref", &reference, &before.tree_id, ""],
        None,
        None,
    )
    .is_ok()
    {
        return Ok(before.clone());
    }
    // A concurrent initializer may have won; a broken ref must remain an error.
    read(workspace, &reference)?.ok_or(())
}

fn read(workspace: &Path, reference: &str) -> Result<Option<GitTreeSnapshot>, ()> {
    let output = git_output(
        workspace,
        [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            reference,
        ],
        None,
        None,
    )
    .map_err(|_| ())?;
    let listing = String::from_utf8(output).map_err(|_| ())?;
    let Some(tree_id) = listing.lines().find_map(|line| {
        let (name, oid) = line.split_once(' ')?;
        (name == reference).then_some(oid)
    }) else {
        return Ok(None);
    };
    let kind = git_output(workspace, ["cat-file", "-t", tree_id], None, None).map_err(|_| ())?;
    if kind != b"tree\n" {
        return Err(());
    }
    Ok(Some(GitTreeSnapshot {
        tree_id: tree_id.to_owned(),
    }))
}
