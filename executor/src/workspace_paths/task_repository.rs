// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

use super::{
    metadata::{self, Entry},
    resolve_logical_path, workspace_root,
};

/// Task-only API calls need a durable binding after repository paths stop using task IDs.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct TaskRepository {
    pub key: String,
    pub name: String,
}

impl TaskRepository {
    pub fn path(&self) -> PathBuf {
        workspace_root().join(&self.key)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.key.is_empty()
            || self.key.contains(['\\', ':'])
            || self.key.chars().any(char::is_control)
            || !Path::new(&self.key)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !component(&self.name)
        {
            return Err("Invalid task repository binding".into());
        }
        Ok(())
    }
}

fn component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && !value.chars().any(char::is_control)
}

fn binding_path(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    if !component(task_id) {
        return Err("Invalid task ID for repository binding".into());
    }
    Ok(metadata::path(root, Entry::Tasks)?.join(format!("{task_id}.json")))
}

pub(crate) fn read(task_id: &str) -> Result<Option<TaskRepository>, String> {
    read_at(&workspace_root(), task_id)
}

pub(crate) fn read_at(root: &Path, task_id: &str) -> Result<Option<TaskRepository>, String> {
    let path = binding_path(root, task_id)?;
    let metadata = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result.map_err(|error| error.to_string())?,
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("Invalid task repository binding file".into());
    }
    let binding: TaskRepository =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|_| "Invalid task repository binding JSON")?;
    binding.validate()?;
    if root
        .join(&binding.key)
        .ancestors()
        .take_while(|path| *path != root)
        .any(Path::is_symlink)
    {
        return Err("Task repository must not be a symlink".into());
    }
    Ok(Some(binding))
}

pub(crate) fn bind(task_id: &str, path: &Path, name: &str) -> Result<(), String> {
    bind_at(&workspace_root(), task_id, path, name)
}

pub(crate) fn bind_at(root: &Path, task_id: &str, path: &Path, name: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Repository is outside its configured workspace root")?;
    let binding = TaskRepository {
        key: relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        name: name.to_owned(),
    };
    binding.validate()?;
    let target = binding_path(root, task_id)?;
    let parent = target.parent().unwrap();
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    staged
        .write_all(&serde_json::to_vec(&binding).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    match staged.persist_noclobber(target) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_at(root, task_id)?.as_ref() == Some(&binding) {
                Ok(())
            } else {
                Err(
                    "Task is already bound to another repository; existing binding was preserved"
                        .into(),
                )
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn resolve_api_path(raw: &str) -> Result<PathBuf, String> {
    let resolved = resolve_logical_path(raw);
    let Some(rest) = raw.trim().strip_prefix("/workspace/") else {
        return Ok(resolved);
    };
    let (task_id, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    if !component(task_id) || !suffix.is_empty() {
        return Ok(resolved);
    }
    let Some(binding) = read(task_id)? else {
        return Ok(resolved);
    };
    // Only the default tree root is an alias. Task-local attachments keep their paths.
    Ok(binding.path())
}
