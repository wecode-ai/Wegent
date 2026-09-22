// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::codex_global_state::CodexGlobalProjectIndex;
use super::util::normalize_workspace_path;
use crate::task_runtime::{LocalTaskStore, TaskRuntimeError};
use std::collections::HashSet;

pub(crate) fn sync_local_collaboration_projects(
    store: &LocalTaskStore,
) -> Result<HashSet<String>, TaskRuntimeError> {
    let mut workspace_paths = HashSet::new();
    let mut duplicate_keys = HashSet::new();
    for project in CodexGlobalProjectIndex::load().projects() {
        if project.remote_host_id.is_some() || project.kind != "local" {
            continue;
        }
        let workspace_path = normalize_workspace_path(&project.workspace_path);
        if workspace_paths.contains(&workspace_path) {
            duplicate_keys.insert(project.key.clone());
            continue;
        }
        let bound_local_id = project.default_project_space.as_ref().and_then(|space| {
            (space.get("projectStore").and_then(|value| value.as_str()) == Some("local"))
                .then(|| space.get("projectId").and_then(|value| value.as_str()))
                .flatten()
        });
        // An archived alias remains a tombstone, but it must not hide the next
        // active alias for the same directory.
        if store.ensure_code_project(&project.key, &project.name, &project.roots, bound_local_id)? {
            workspace_paths.insert(workspace_path);
        }
    }
    Ok(duplicate_keys)
}
