// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::codex_global_state::{CodexGlobalProject, CodexGlobalProjectIndex};
use super::util::normalize_workspace_path;
use crate::task_runtime::{LocalTaskStore, TaskRuntimeError};
use std::collections::HashSet;
use wegent_runtime_logging::project_index_diagnostics::trace;

pub(crate) fn sync_local_collaboration_projects(
    store: &LocalTaskStore,
) -> Result<HashSet<String>, TaskRuntimeError> {
    let index = trace("projects_list.index", CodexGlobalProjectIndex::load);
    sync_projects(index.projects(), |project, bound_local_id| {
        match store.code_project_visibility(&project.key, bound_local_id)? {
            Some(visible) => Ok(visible),
            None => store.ensure_code_project(
                &project.key,
                &project.name,
                &project.roots,
                bound_local_id,
            ),
        }
    })
}

fn sync_projects(
    projects: &[CodexGlobalProject],
    mut ensure: impl FnMut(&CodexGlobalProject, Option<&str>) -> Result<bool, TaskRuntimeError>,
) -> Result<HashSet<String>, TaskRuntimeError> {
    let mut workspace_paths = HashSet::new();
    let mut duplicate_keys = HashSet::new();
    for project in projects {
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
        let visible = match trace("projects_list.ensure_code_project", || {
            ensure(project, bound_local_id)
        }) {
            Ok(visible) => visible,
            Err(TaskRuntimeError::ProjectDiscovery(error)) => {
                crate::logging::log_executor_event(
                    "project discovery failed",
                    &[("project_key", project.key.clone()), ("error", error)],
                );
                continue;
            }
            Err(error) => return Err(error),
        };
        if visible {
            workspace_paths.insert(workspace_path);
        }
    }
    Ok(duplicate_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(key: &str) -> CodexGlobalProject {
        CodexGlobalProject {
            key: key.into(),
            workspace_path: format!("/catalog/{key}"),
            roots: vec![],
            name: key.into(),
            source: "local".into(),
            kind: "local".into(),
            remote_host_id: None,
            owner_project_key: None,
            pinned: false,
            pinned_order: None,
            active: false,
            appearance: None,
            default_project_space: None,
            ai_settings: None,
        }
    }

    #[test]
    fn discovery_failure_preserves_other_imports_and_leaves_failed_project_retryable() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let projects = [project("before"), project("unavailable"), project("after")];
        sync_projects(&projects, |project, bound| {
            if project.key == "unavailable" {
                return Err(TaskRuntimeError::ProjectDiscovery("timed out".into()));
            }
            store.ensure_code_project(&project.key, &project.name, &project.roots, bound)
        })
        .unwrap();
        assert!(store
            .code_project_visibility("before", None)
            .unwrap()
            .unwrap());
        assert!(store
            .code_project_visibility("after", None)
            .unwrap()
            .unwrap());
        assert_eq!(
            store.code_project_visibility("unavailable", None).unwrap(),
            None
        );
        sync_projects(&projects, |project, bound| {
            store.ensure_code_project(&project.key, &project.name, &project.roots, bound)
        })
        .unwrap();
        assert!(store
            .code_project_visibility("unavailable", None)
            .unwrap()
            .unwrap());
        assert!(matches!(
            sync_projects(&projects, |_, _| Err(TaskRuntimeError::LockPoisoned)),
            Err(TaskRuntimeError::LockPoisoned)
        ));
    }
}
