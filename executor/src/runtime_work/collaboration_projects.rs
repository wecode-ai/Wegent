// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::codex_global_state::CodexGlobalProjectIndex;
use crate::task_runtime::{LocalTaskStore, TaskRuntimeError};

pub(crate) fn sync_local_collaboration_projects(
    store: &LocalTaskStore,
) -> Result<(), TaskRuntimeError> {
    for project in CodexGlobalProjectIndex::load().projects() {
        if project.remote_host_id.is_some() || project.kind != "local" {
            continue;
        }
        let bound_local_id = project.default_project_space.as_ref().and_then(|space| {
            (space.get("projectStore").and_then(|value| value.as_str()) == Some("local"))
                .then(|| space.get("projectId").and_then(|value| value.as_str()))
                .flatten()
        });
        store.ensure_code_project(&project.key, &project.name, &project.roots, bound_local_id)?;
    }
    Ok(())
}
