// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::TempDir;

use super::{git_artifacts, git_stream};

static CHECKPOINT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A working-tree boundary with a private index and a GC-protected tree.
#[derive(Debug)]
pub struct GitTurnSnapshot {
    workspace: PathBuf,
    tree: String,
    reference: Option<String>,
    index: Arc<TempDir>,
}

/// Immutable inputs for background diff generation, persisted before delivery.
/// References stay pinned across process restarts until `release` is called.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitTurnRange {
    workspace: PathBuf,
    before: String,
    after: String,
    before_ref: String,
    after_ref: String,
    hooks_directory: PathBuf,
    #[serde(skip, default = "persisted_ownership")]
    queued: Arc<AtomicBool>,
}

impl GitTurnSnapshot {
    pub fn capture(workspace: &Path) -> Result<Option<Self>, String> {
        if !super::is_git_workspace(workspace) {
            return Ok(None);
        }
        let root = git_stream::output(workspace, &["rev-parse", "--show-toplevel"], None)?;
        let workspace = PathBuf::from(text(root)?);
        let index = tempfile::Builder::new()
            .prefix("wegent-hook-index-")
            .tempdir()
            .map_err(error)?;
        let env = index_environment(&index);
        if git_stream::output(&workspace, &["rev-parse", "--verify", "HEAD"], None).is_ok() {
            // A private index avoids inheriting assume-unchanged flags or
            // changing the user's staged state. Freeze reuses its stat cache.
            git_stream::output(&workspace, &["read-tree", "HEAD"], Some(&env))?;
        }
        let tree = capture_tree(&workspace, &env)?;
        let name = index
            .path()
            .file_name()
            .ok_or("missing index name")?
            .to_string_lossy();
        let reference = format!("refs/wegent/turn-hooks/{name}/before");
        pin(&workspace, &reference, &tree, index.path())?;
        Ok(Some(Self {
            workspace,
            tree,
            reference: Some(reference),
            index: Arc::new(index),
        }))
    }

    /// Keep the current baseline until the caller durably queues the range.
    /// The returned snapshot starts at exactly the range's ending tree and
    /// reuses the private index cache. Use the two snapshots sequentially.
    pub fn checkpoint(&mut self) -> Result<(GitTurnRange, Self), String> {
        let after = capture_tree(&self.workspace, &index_environment(&self.index))?;
        let name = self
            .index
            .path()
            .file_name()
            .ok_or("missing index name")?
            .to_string_lossy();
        let sequence = CHECKPOINT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let prefix = format!("refs/wegent/turn-hooks/{name}/checkpoint-{sequence}");
        let mut before = self.pinned_copy(&self.tree, format!("{prefix}/range/before"))?;
        let mut ending = self.pinned_copy(&after, format!("{prefix}/range/after"))?;
        let next = self.pinned_copy(&after, format!("{prefix}/next/before"))?;
        let range = GitTurnRange {
            workspace: self.workspace.clone(),
            before: self.tree.clone(),
            after,
            before_ref: before
                .reference
                .take()
                .ok_or("missing checkpoint reference")?,
            after_ref: ending.reference.take().ok_or("missing ending reference")?,
            hooks_directory: self.index.path().to_path_buf(),
            queued: Arc::new(AtomicBool::new(false)),
        };
        Ok((range, next))
    }

    fn pinned_copy(&self, tree: &str, reference: String) -> Result<Self, String> {
        pin(&self.workspace, &reference, tree, self.index.path())?;
        Ok(Self {
            workspace: self.workspace.clone(),
            tree: tree.to_owned(),
            reference: Some(reference),
            index: Arc::clone(&self.index),
        })
    }

    /// Seal the live workspace now. Background work reads only these trees.
    pub fn freeze(mut self) -> Result<GitTurnRange, String> {
        let after = capture_tree(&self.workspace, &index_environment(&self.index))?;
        let before_ref = self
            .reference
            .as_ref()
            .ok_or("missing snapshot reference")?;
        let after_ref = format!("{}/after", before_ref.trim_end_matches("/before"));
        pin(&self.workspace, &after_ref, &after, self.index.path())?;
        Ok(GitTurnRange {
            workspace: self.workspace.clone(),
            before: self.tree.clone(),
            after,
            before_ref: self.reference.take().ok_or("missing snapshot reference")?,
            after_ref,
            hooks_directory: self.index.path().to_path_buf(),
            queued: Arc::new(AtomicBool::new(false)),
        })
    }
}

impl Drop for GitTurnSnapshot {
    fn drop(&mut self) {
        if let Some(reference) = self.reference.take() {
            if let Err(error) = release_reference(&self.workspace, &reference, self.index.path()) {
                crate::logging::log_executor_event(
                    "turn snapshot reference cleanup failed",
                    &[("error", error)],
                );
            }
        }
    }
}

impl GitTurnRange {
    /// Called only after durable storage has accepted ownership of the pins.
    pub fn mark_queued(&self) {
        self.queued.store(true, Ordering::Release);
    }

    /// All local clones share the ownership transfer. Deserialized ranges are
    /// already durable and must never be reclaimed by a failed enqueue.
    pub fn release_if_unqueued(&self) -> Result<(), String> {
        if self.queued.load(Ordering::Acquire) {
            Ok(())
        } else {
            self.release()
        }
    }

    pub fn workspace_path(&self) -> &Path {
        &self.workspace
    }

    /// Generate complete artifacts with bounded buffers. No live files are read.
    pub fn materialize(&self, directory: &Path) -> Result<Value, String> {
        git_artifacts::materialize(&self.workspace, &self.before, &self.after, directory)
    }

    pub fn release(&self) -> Result<(), String> {
        for reference in [&self.before_ref, &self.after_ref] {
            release_reference(&self.workspace, reference, &self.hooks_directory)?;
        }
        Ok(())
    }
}

fn persisted_ownership() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

fn index_environment(index: &TempDir) -> BTreeMap<String, String> {
    BTreeMap::from([(
        "GIT_INDEX_FILE".to_owned(),
        index.path().join("index").to_string_lossy().into_owned(),
    )])
}

fn capture_tree(workspace: &Path, env: &BTreeMap<String, String>) -> Result<String, String> {
    sync_tracked_files(workspace, env)?;
    git_stream::output(workspace, &["add", "--all", "--", "."], Some(env))?;
    text(git_stream::output(workspace, &["write-tree"], Some(env))?)
}

fn sync_tracked_files(workspace: &Path, env: &BTreeMap<String, String>) -> Result<(), String> {
    use std::io::{Seek, Write};

    // The real index owns tracked membership, including force-added ignored
    // files. Its flags and staged contents must never become our baseline.
    let mut paths = tempfile::tempfile().map_err(error)?;
    git_stream::block_on(async {
        let mut tracked =
            git_stream::GitStream::spawn(workspace, &["ls-files", "--cached", "-z"], None)?;
        let mut buffer = [0; git_stream::BUFFER_BYTES];
        loop {
            let count = tracked.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            paths.write_all(&buffer[..count]).map_err(error)?;
        }
        tracked.finish().await?;
        paths.rewind().map_err(error)?;
        let mut update = git_stream::GitStream::with_input(
            workspace,
            &["update-index", "--add", "--remove", "-z", "--stdin"],
            env,
            paths,
        )?;
        while update.read(&mut buffer).await? != 0 {}
        update.finish().await
    })
}

fn pin(
    workspace: &Path,
    reference: &str,
    tree: &str,
    hooks_directory: &Path,
) -> Result<(), String> {
    let hooks = format!("core.hooksPath={}", hooks_directory.display());
    git_stream::output(
        workspace,
        &["-c", &hooks, "update-ref", reference, tree],
        None,
    )
    .map(|_| ())
}

/// Ref ownership also ends when an async caller is cancelled. Destruction must
/// not create or enter a Tokio runtime. Internal refs never run repository hooks.
fn release_reference(
    workspace: &Path,
    reference: &str,
    hooks_directory: &Path,
) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let mut command = Command::new("git");
    crate::native_git::clear_local_git_env(&mut command);
    crate::process::hide_windows_console(&mut command);
    let status = command
        .args([
            "-c",
            &format!("core.hooksPath={}", hooks_directory.display()),
            "-C",
        ])
        .arg(workspace)
        .args(["update-ref", "-d", reference])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(error)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Git reference cleanup failed: {status}"))
    }
}

fn text(output: Vec<u8>) -> Result<String, String> {
    String::from_utf8(output)
        .map(|value| value.trim_end_matches(['\r', '\n']).to_owned())
        .map_err(error)
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "git_turn_snapshot_tests.rs"]
mod tests;
