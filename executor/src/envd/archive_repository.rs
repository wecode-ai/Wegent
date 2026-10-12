// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io, path::Path};

use crate::workspace_paths::task_repository::{self, TaskRepository};

pub(super) const MEMBER: &str = "repository-binding.json";

pub(super) fn encode(workspace: &Path, repository: &Path, name: &str) -> io::Result<Vec<u8>> {
    let root = workspace
        .parent()
        .ok_or_else(|| io::Error::other("Missing workspace root"))?;
    let key = repository.strip_prefix(root).map_err(io::Error::other)?;
    let binding = TaskRepository {
        key: key
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        name: name.to_owned(),
    };
    validate(&binding, workspace)?;
    serde_json::to_vec(&binding).map_err(io::Error::other)
}

pub(super) fn decode(bytes: &[u8], workspace: &Path, task_id: &str) -> io::Result<TaskRepository> {
    let binding: TaskRepository = serde_json::from_slice(bytes).map_err(io::Error::other)?;
    validate(&binding, workspace)?;
    let root = workspace.parent().unwrap();
    if task_repository::read_at(root, task_id)
        .map_err(io::Error::other)?
        .is_some()
    {
        return Err(io::Error::other("Cannot restore over a bound repository"));
    }
    let target = root.join(&binding.key);
    for ancestor in target.ancestors().take_while(|path| *path != root) {
        if ancestor.is_symlink() {
            return Err(io::Error::other(
                "Repository restore path contains a symlink",
            ));
        }
    }
    fs::create_dir_all(target.parent().unwrap())?;
    // Reserve a new checkout; never merge a backup into an existing repository.
    fs::create_dir(target)?;
    Ok(binding)
}

fn validate(binding: &TaskRepository, workspace: &Path) -> io::Result<()> {
    binding.validate().map_err(io::Error::other)?;
    let root = workspace
        .parent()
        .ok_or_else(|| io::Error::other("Missing workspace root"))?;
    let target = root.join(&binding.key);
    let reserved = [
        ".wegent",
        ".repository-tasks",
        ".repository-locks",
        ".repository-publish.lock",
    ];
    if target.starts_with(workspace)
        || workspace.starts_with(&target)
        || reserved
            .iter()
            .any(|name| Path::new(&binding.key).starts_with(name))
    {
        return Err(io::Error::other("Invalid shared repository archive path"));
    }
    Ok(())
}

pub(super) fn publish(binding: &TaskRepository, workspace: &Path, task_id: &str) -> io::Result<()> {
    let root = workspace.parent().unwrap();
    task_repository::bind_at(root, task_id, &root.join(&binding.key), &binding.name)
        .map_err(io::Error::other)
}
