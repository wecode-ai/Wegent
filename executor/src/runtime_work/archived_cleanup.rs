// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use super::{response::RuntimeTaskLink, util::normalize_workspace_path};

pub(super) fn managed_worktree_roots() -> Vec<PathBuf> {
    let Some(home) = env::var_os("HOME") else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    vec![
        home.join(".wegent-executor/workspace/worktrees"),
        home.join(".wecode/wegent-executor/workspace/worktrees"),
    ]
}

pub(super) fn managed_worktree_container(path: &str) -> Option<PathBuf> {
    let mut container = PathBuf::new();
    let mut components = Path::new(path).components();
    while let Some(component) = components.next() {
        container.push(component.as_os_str());
        if component.as_os_str() != "worktrees" {
            continue;
        }
        let task_dir = components.next()?;
        let task_dir = task_dir.as_os_str().to_str()?;
        if !is_runtime_worktree_dir_name(task_dir) {
            return None;
        }
        container.push(task_dir);
        return Some(container);
    }
    None
}

fn is_runtime_worktree_dir_name(name: &str) -> bool {
    name.strip_prefix("runtime-").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub(super) fn orphaned_managed_worktree_links(
    protected_worktree_dirs: &HashSet<PathBuf>,
    worktree_roots: &[PathBuf],
) -> Vec<RuntimeTaskLink> {
    let mut links = Vec::new();
    for root in worktree_roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_runtime_worktree_dir_name(name) || protected_worktree_dirs.contains(&path) {
                continue;
            }
            links.push(RuntimeTaskLink::new_pending(
                format!("orphaned-worktree-{name}"),
                normalize_workspace_path(&path.to_string_lossy()),
                "Orphaned worktree".to_owned(),
            ));
        }
    }
    links
}
