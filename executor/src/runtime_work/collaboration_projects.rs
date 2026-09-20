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
        // Match workspace_response: the first project for a main directory owns
        // the sidebar row. Additional writable roots never create project rows.
        let first_for_path =
            workspace_paths.insert(normalize_workspace_path(&project.workspace_path));
        if project.remote_host_id.is_some() || project.kind != "local" {
            continue;
        }
        if !first_for_path {
            duplicate_keys.insert(project.key.clone());
            continue;
        }
        let bound_local_id = project.default_project_space.as_ref().and_then(|space| {
            (space.get("projectStore").and_then(|value| value.as_str()) == Some("local"))
                .then(|| space.get("projectId").and_then(|value| value.as_str()))
                .flatten()
        });
        store.ensure_code_project(&project.key, &project.name, &project.roots, bound_local_id)?;
    }
    Ok(duplicate_keys)
}
