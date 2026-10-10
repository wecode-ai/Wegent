// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

use super::{
    clone_repo, git_url_contains_credentials, resolve_git_project_path, setup_git_config,
    validate_existing_git_repository,
};
use crate::{
    protocol::ExecutionRequest,
    repository_identity::RepositoryIdentity,
    workspace_paths::{
        metadata::{self, lock_file, Entry},
        task_repository, workspace_root,
    },
};

/// Plain shared checkouts are single-writer. Explicit workspaces/worktrees keep
/// their existing execution policy; no automatic worktree mode is introduced.
pub(crate) fn acquire_execution_lease(request: &ExecutionRequest) -> Result<Option<File>, String> {
    if (request.skip_git_clone && task_repository::read(&request.task_id)?.is_none())
        || request
            .project_workspace_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
        || request
            .extra
            .get("interactive_form_answer")
            .is_some_and(|value| !value.is_null())
    {
        return Ok(None);
    }
    let Some(url) = request.git_url() else {
        return Ok(None);
    };
    let identity = RepositoryIdentity::from_url(&url)?;
    repository_lease(&identity).map(Some)
}

pub(crate) async fn acquire_archive_lease(path: &Path) -> Result<File, String> {
    let identity = checkout_identity(path)
        .await?
        .ok_or("Archive repository has no origin")?;
    repository_lease(&identity)
}

fn repository_lease(identity: &RepositoryIdentity) -> Result<File, String> {
    let locks = metadata::path(&workspace_root(), Entry::Locks)?;
    fs::create_dir_all(&locks).map_err(|error| error.to_string())?;
    lock_file(&locks.join(format!("{}.lock", identity.digest)))
        .map_err(|_| "Repository is already in use or cannot be locked; use a separate worktree for parallel tasks".into())
}

async fn publication_lease(root: &Path) -> Result<File, String> {
    let path = metadata::path(root, Entry::Publish)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match lock_file(&path) {
            Ok(file) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if tokio::time::Instant::now() >= deadline {
                    return Err("Repository publication lock timed out".into());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

pub(super) async fn prepare(
    mut request: ExecutionRequest,
    url: &str,
    name: &str,
) -> Result<ExecutionRequest, String> {
    if git_url_contains_credentials(url) {
        return Err("Git repository URL must not contain credentials or a query".into());
    }
    let identity = RepositoryIdentity::from_url(url)?;
    let root = workspace_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // An existing task/project path is a historical binding, not a relocation candidate.
    let legacy = resolve_git_project_path(&request, name);
    let binding = task_repository::read(&request.task_id)?;
    let path = if let Some(binding) = binding {
        let path = binding.path();
        if !path.try_exists().map_err(|error| error.to_string())? {
            return Err("Task repository is missing; restore its original directory instead of cloning a replacement".into());
        }
        require_identity(&path, &identity).await?;
        validate_existing_git_repository(&path).await?;
        path
    } else if legacy.try_exists().map_err(|error| error.to_string())? {
        require_identity(&legacy, &identity).await?;
        validate_existing_git_repository(&legacy).await?;
        legacy
    } else {
        require_new_checkout(&request, name)?;
        let path = select_path(&root, &identity).await?;
        if path.try_exists().map_err(|error| error.to_string())? {
            validate_existing_git_repository(&path).await?;
            path
        } else {
            // Only disposable staging is cleaned after a failed clone, never an
            // existing checkout with an invalid or unborn HEAD.
            let staging = tempfile::Builder::new()
                .prefix(".clone-")
                .tempdir_in(&root)
                .map_err(|error| error.to_string())?;
            let clone = staging.path().join("repository");
            clone_repo(&request, url, &clone).await?;
            require_identity(&clone, &identity).await?;
            validate_existing_git_repository(&clone).await?;
            let _publication = publication_lease(&root).await?;
            let target = select_path(&root, &identity).await?;
            if !target.try_exists().map_err(|error| error.to_string())? {
                fs::rename(&clone, &target).map_err(|error| error.to_string())?;
            } else {
                validate_existing_git_repository(&target).await?;
            }
            target
        }
    };
    // The requested branch is a clone input, not a constraint on an existing checkout.
    crate::workspace_paths::task_repository::bind(&request.task_id, &path, name)?;
    setup_git_config(&request, &path).await;
    request.project_workspace_path = Some(path.display().to_string());
    crate::logging::log_executor_event(
        "git managed workspace prepared",
        &[
            ("task_id", request.task_id.clone()),
            ("path", path.display().to_string()),
            (
                "repository_key",
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
    );
    Ok(request)
}

fn require_new_checkout(request: &ExecutionRequest, name: &str) -> Result<(), String> {
    if crate::agent_session::saved_executor_session(request).is_some() {
        return Err("Existing task session has no workspace binding; restore the original WORKSPACE_ROOT or supply its original project_workspace_path".into());
    }
    // Probe only this task in explicitly configured historical roots. Never scan
    // home directories or import checkouts belonging to other tasks/devices.
    for root in crate::workspace_paths::historical_workspace_roots() {
        let candidate = root.join(&request.task_id).join(name);
        if candidate.try_exists().map_err(|error| error.to_string())? {
            return Err(format!(
                "Historical task workspace exists at {}; preserve its WORKSPACE_ROOT instead of cloning a replacement",
                candidate.display()
            ));
        }
    }
    Ok(())
}

async fn select_path(root: &Path, identity: &RepositoryIdentity) -> Result<PathBuf, String> {
    let mut available = None;
    for length in (8..=64).step_by(4) {
        let path = root.join(identity.key(length));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if available.is_none() {
                    available = Some(path);
                }
            }
            Err(error) => return Err(error.to_string()),
            Ok(metadata) if metadata.is_dir() && path.join(".git").exists() => {
                if checkout_identity(&path).await?.as_ref() == Some(identity) {
                    return Ok(path);
                }
            }
            Ok(_) => {}
        }
    }
    available
        .ok_or_else(|| "No unoccupied repository key; existing directories were preserved".into())
}

async fn require_identity(path: &Path, identity: &RepositoryIdentity) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
        || checkout_identity(path).await?.as_ref() != Some(identity)
    {
        return Err(
            "Existing workspace belongs to another Git repository; no files were changed".into(),
        );
    }
    Ok(())
}

async fn checkout_identity(path: &Path) -> Result<Option<RepositoryIdentity>, String> {
    let Some(remote) =
        git_value(path, &["config", "--local", "--get", "remote.origin.url"]).await?
    else {
        return Ok(None);
    };
    let remote = remote.trim();
    let address = if !remote.contains(':') && !Path::new(remote).is_absolute() {
        path.join(remote).display().to_string()
    } else {
        remote.to_owned()
    };
    RepositoryIdentity::from_url(&address).map(Some)
}

async fn git_value(path: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let mut command = Command::new("git");
    crate::local::native_git::clear_local_git_env(command.as_std_mut());
    crate::process::hide_windows_console(&mut command);
    command
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "Git repository lookup timed out")?
        .map_err(|error| error.to_string())?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err("Cannot read Git repository state".into());
    }
    let value = String::from_utf8(output.stdout).map_err(|_| "Invalid Git repository encoding")?;
    Ok(Some(value.trim().to_owned()))
}

#[cfg(test)]
mod tests;
