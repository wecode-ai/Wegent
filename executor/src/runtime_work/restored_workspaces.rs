// SPDX-License-Identifier: Apache-2.0

use std::path::{Component, Path, PathBuf};

use super::util::normalize_workspace_path;

pub(crate) fn root() -> PathBuf {
    crate::agents::executor_home().join("restored-workspaces")
}

/// Materialized transcripts own their directory, independently of ancestor VCS metadata.
pub(crate) fn workspace_root(path: &str) -> Option<String> {
    let root = normalize_workspace_path(&root().to_string_lossy());
    let normalized = normalize_workspace_path(path);
    let relative = Path::new(&normalized).strip_prefix(&root).ok()?;
    let Component::Normal(task) = relative.components().next()? else {
        return None;
    };
    Some(Path::new(&root).join(task).to_string_lossy().into_owned())
}
