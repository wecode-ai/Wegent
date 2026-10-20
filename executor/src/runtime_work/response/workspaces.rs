// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::util::{
    infer_workspace_kind, normalize_workspace_path, now_ms, path_is_within, workspace_group_path,
    workspace_label, workspace_task_path,
};
use super::{
    compare_runtime_task_links, git_info_for_workspace, local_task_json, RuntimeTaskLink,
    RuntimeWorkspaceLink,
};
use serde_json::{json, Value};
use std::collections::HashMap;

type WorkspaceGroup = (Option<RuntimeWorkspaceLink>, Vec<RuntimeTaskLink>);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum WorkspaceGroupKey {
    Project(Option<String>, String),
    Directory(String),
}

impl WorkspaceGroupKey {
    fn for_workspace(workspace: &RuntimeWorkspaceLink) -> Self {
        if !workspace.project_key.is_empty() || workspace.remote_host_id.is_some() {
            Self::Project(
                workspace.remote_host_id.clone(),
                if workspace.project_key.is_empty() {
                    workspace.workspace_path.clone()
                } else {
                    workspace.project_key.clone()
                },
            )
        } else {
            Self::Directory(workspace.workspace_path.clone())
        }
    }
}

fn task_group(
    link: &RuntimeTaskLink,
    path: &str,
    groups: &HashMap<WorkspaceGroupKey, WorkspaceGroup>,
) -> WorkspaceGroupKey {
    if let Some(project_key) = link
        .group_project_key
        .as_deref()
        .or(link.runtime_project_key.as_deref())
    {
        let mut matches = groups.iter().filter(|(_, (workspace, _))| {
            workspace
                .as_ref()
                .is_some_and(|workspace| workspace.project_key == project_key)
        });
        if let Some((key, _)) = matches.next() {
            if matches.next().is_none() {
                return key.clone();
            }
        }
        return WorkspaceGroupKey::Directory(path.to_owned());
    }
    if infer_workspace_kind(&link.workspace_path) == "chat" {
        return WorkspaceGroupKey::Directory(normalize_workspace_path(&link.workspace_path));
    }
    // Unbound local tasks may be grouped by a unique local root. A remote
    // reference with the same path cannot claim them.
    let mut matches = groups
        .iter()
        .filter_map(|(key, (workspace, _))| {
            let workspace = workspace.as_ref()?;
            (workspace.remote_host_id.is_none()
                && workspace.workspace_source != "remote"
                && path_is_within(&workspace.workspace_path, path))
            .then_some((key, workspace.workspace_path.len()))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|(_, length)| std::cmp::Reverse(*length));
    match matches.as_slice() {
        [(key, _)] => (*key).clone(),
        [(key, length), (_, next_length), ..] if length > next_length => (*key).clone(),
        _ => WorkspaceGroupKey::Directory(path.to_owned()),
    }
}

pub(crate) fn workspace_response(
    links: Vec<RuntimeTaskLink>,
    workspaces: Vec<RuntimeWorkspaceLink>,
) -> Vec<Value> {
    let mut groups = HashMap::<WorkspaceGroupKey, WorkspaceGroup>::new();
    let mut workspace_order = HashMap::<WorkspaceGroupKey, usize>::new();
    for (index, mut workspace) in workspaces.into_iter().enumerate() {
        workspace.workspace_path = normalize_workspace_path(&workspace.workspace_path);
        let key = WorkspaceGroupKey::for_workspace(&workspace);
        workspace_order.entry(key.clone()).or_insert(index);
        groups
            .entry(key)
            .and_modify(|(existing, _)| {
                if let Some(existing) = existing {
                    existing.updated_at = existing.updated_at.max(workspace.updated_at);
                    if existing.title.is_empty() {
                        existing.title = workspace.title.clone();
                    }
                }
            })
            .or_insert_with(|| (Some(workspace), Vec::new()));
    }

    for mut link in links {
        link.git_info = git_info_for_workspace(link.git_info.take(), &link.workspace_path);
        let path = link
            .group_workspace_path
            .clone()
            .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
        let key = task_group(&link, &path, &groups);
        let group_path = groups
            .get(&key)
            .and_then(|(workspace, _)| workspace.as_ref())
            .map(|workspace| workspace.workspace_path.clone())
            .unwrap_or(path);
        let execution_group = if link.preserve_execution_path {
            workspace_group_path(&link.workspace_path)
        } else {
            group_path
        };
        link.workspace_path = workspace_task_path(&link.workspace_path, &execution_group);
        groups
            .entry(key)
            .or_insert_with(|| (None, Vec::new()))
            .1
            .push(link);
    }

    let mut workspaces = groups
        .into_iter()
        .map(|(group_key, (workspace, mut tasks))| {
            let workspace_path = workspace
                .as_ref()
                .map(|item| item.workspace_path.clone())
                .unwrap_or_else(|| match &group_key {
                    WorkspaceGroupKey::Directory(path) => path.clone(),
                    WorkspaceGroupKey::Project(_, key) => key.clone(),
                });
            tasks.sort_by(compare_runtime_task_links);
            let updated_at = tasks
                .iter()
                .map(|link| link.updated_at)
                .max()
                .or_else(|| workspace.as_ref().map(|workspace| workspace.updated_at))
                .unwrap_or_else(now_ms);
            let label = workspace
                .as_ref()
                .map(|workspace| workspace.title.clone())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| workspace_label(&workspace_path));
            let workspace_source = workspace
                .as_ref()
                .map(|workspace| workspace.workspace_source.clone())
                .filter(|source| !source.is_empty())
                .unwrap_or_else(|| "local".to_owned());
            let remote_host_id = workspace
                .as_ref()
                .and_then(|workspace| workspace.remote_host_id.clone());
            let project_key = workspace
                .as_ref()
                .map(|workspace| workspace.project_key.clone())
                .filter(|value| !value.is_empty());
            let workspace_kind = match workspace
                .as_ref()
                .map(|workspace| workspace.project_source.as_str())
            {
                Some("local_project" | "remote_project") => "workspace",
                _ => infer_workspace_kind(&workspace_path),
            };
            let mut workspace_json = json!({
                "workspacePath": workspace_path,
                "workspaceKind": workspace_kind,
                "label": label,
                "workspaceSource": workspace_source,
                "tasks": tasks
                    .into_iter()
                    .map(local_task_json)
                    .collect::<Vec<_>>(),
                "updatedAt": updated_at,
            });
            if let Some(workspace) = workspace.as_ref() {
                if let Some(project_key) = project_key {
                    workspace_json["projectKey"] = Value::String(project_key);
                }
                workspace_json["projectKind"] = Value::String(workspace.project_kind.clone());
                workspace_json["projectSource"] = Value::String(workspace.project_source.clone());
                workspace_json["projectRoots"] = json!(workspace.project_roots);
                if let Some(owner_project_key) = workspace.owner_project_key.as_ref() {
                    workspace_json["ownerProjectKey"] = json!(owner_project_key);
                }
                if let Some(order) = workspace.project_sidebar_order {
                    workspace_json["projectSidebarOrder"] = json!(order);
                }
                workspace_json["projectPinned"] = Value::Bool(workspace.project_pinned);
                if let Some(order) = workspace.project_pinned_order {
                    workspace_json["projectPinnedOrder"] = json!(order);
                }
                workspace_json["projectActive"] = Value::Bool(workspace.project_active);
                if let Some(appearance) = workspace.project_appearance.clone() {
                    workspace_json["projectAppearance"] = appearance;
                }
                if let Some(default_project_space) = workspace.default_project_space.clone() {
                    workspace_json["defaultProjectSpace"] = default_project_space;
                }
                if let Some(ai_settings) = workspace.project_ai_settings.clone() {
                    workspace_json["projectAiSettings"] = ai_settings;
                }
            }
            if let Some(remote_host_id) = remote_host_id {
                workspace_json["remoteHostId"] = Value::String(remote_host_id);
            }
            (
                workspace_json,
                workspace_order.get(&group_key).copied(),
                updated_at,
                workspace_path,
            )
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| match (left.1, right.1) {
        (Some(left_order), Some(right_order)) => left_order.cmp(&right_order),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => right.2.cmp(&left.2).then_with(|| left.3.cmp(&right.3)),
    });
    workspaces
        .into_iter()
        .map(|(workspace, _, _, _)| workspace)
        .collect::<Vec<_>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(key: &str, host: Option<&str>) -> RuntimeWorkspaceLink {
        RuntimeWorkspaceLink {
            project_key: key.to_owned(),
            workspace_path: "/srv/work".to_owned(),
            title: key.to_owned(),
            project_kind: if host.is_some() { "remote" } else { "local" }.to_owned(),
            project_source: if host.is_some() {
                "remote_project"
            } else {
                "local_project"
            }
            .to_owned(),
            workspace_source: if host.is_some() { "remote" } else { "local" }.to_owned(),
            remote_host_id: host.map(str::to_owned),
            ..RuntimeWorkspaceLink::default()
        }
    }

    fn task(id: &str, project_key: Option<&str>) -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: id.to_owned(),
            title: id.to_owned(),
            workspace_path: "/srv/work".to_owned(),
            group_project_key: project_key.map(str::to_owned),
            ..RuntimeTaskLink::default()
        }
    }

    #[test]
    fn workspace_response_preserves_full_remote_project_settings() {
        let mut remote = project("sidebar-entry", Some("host-a"));
        remote.owner_project_key = Some("owner-key".to_owned());
        remote.project_roots = vec!["/srv/work".to_owned(), "/srv/second".to_owned()];
        remote.default_project_space = Some(json!({"kind": "local", "id": 42}));
        remote.project_ai_settings = Some(json!({
            "instructions": "Project guidance",
            "modelSelection": {"modelId": "project-model"},
            "quickPhrases": [{"id": "phrase", "title": "Review", "content": "Review", "mode": "plan"}],
            "plugins": [{"id": "plugin", "pluginName": "plugin", "marketplaceId": "market", "displayName": "Plugin"}]
        }));
        let rows = workspace_response(Vec::new(), vec![remote.clone()]);
        assert_eq!(rows[0]["ownerProjectKey"], "owner-key");
        assert_eq!(rows[0]["projectRoots"], json!(remote.project_roots));
        assert_eq!(
            rows[0]["defaultProjectSpace"],
            remote.default_project_space.unwrap()
        );
        assert_eq!(
            rows[0]["projectAiSettings"],
            remote.project_ai_settings.unwrap()
        );
    }

    #[test]
    fn workspace_response_keeps_shared_roots_and_explicit_task_ownership() {
        let rows = workspace_response(
            vec![
                task("task-a", Some("project-a")),
                task("task-b", Some("project-b")),
            ],
            vec![project("project-a", None), project("project-b", None)],
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["projectKey"], "project-a");
        assert_eq!(rows[1]["projectKey"], "project-b");
        assert_eq!(rows[0]["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(rows[1]["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["tasks"][0]["taskId"], "task-a");
        assert_eq!(rows[1]["tasks"][0]["taskId"], "task-b");
    }

    #[test]
    fn workspace_response_preserves_explicit_projects_inside_codex_directories() {
        for host in [None, Some("host-a")] {
            let mut registered = project("project", host);
            registered.workspace_path = "/srv/Documents/Codex/2026-10-16/repo".to_owned();
            registered.project_roots = vec![registered.workspace_path.clone()];
            let mut assigned = task("assigned", Some("project"));
            assigned.workspace_path = registered.workspace_path.clone();

            let rows = workspace_response(vec![assigned], vec![registered]);

            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["projectKey"], "project");
            assert_eq!(rows[0]["workspaceKind"], "workspace");
            assert_eq!(rows[0]["tasks"][0]["taskId"], "assigned");
        }
    }

    #[test]
    fn workspace_response_does_not_assign_standalone_chats_to_an_ancestor_project() {
        let chat_path = "/srv/work/Documents/Codex/chat";
        let mut standalone = task("standalone", None);
        standalone.workspace_path = chat_path.to_owned();
        let mut assigned = task("assigned", Some("project"));
        assigned.workspace_path = chat_path.to_owned();
        let rows = workspace_response(vec![standalone, assigned], vec![project("project", None)]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["tasks"][0]["taskId"], "assigned");
        assert_eq!(rows[1]["workspacePath"], chat_path);
        assert_eq!(rows[1]["workspaceKind"], "chat");
        assert_eq!(rows[1]["tasks"][0]["taskId"], "standalone");
    }

    #[test]
    fn workspace_response_keeps_remote_hosts_separate_from_local_paths() {
        let rows = workspace_response(
            vec![task("local-task", None)],
            vec![
                project("remote", Some("host-a")),
                project("remote", Some("host-b")),
                project("local", None),
            ],
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["remoteHostId"], "host-a");
        assert_eq!(rows[1]["remoteHostId"], "host-b");
        assert!(rows[0]["tasks"].as_array().unwrap().is_empty());
        assert!(rows[1]["tasks"].as_array().unwrap().is_empty());
        assert_eq!(rows[2]["tasks"][0]["taskId"], "local-task");
    }

    #[test]
    fn workspace_response_does_not_guess_between_shared_project_roots() {
        let rows = workspace_response(
            vec![task("unbound", None)],
            vec![project("project-a", None), project("project-b", None)],
        );
        assert_eq!(rows.len(), 3);
        assert!(rows[0]["tasks"].as_array().unwrap().is_empty());
        assert!(rows[1]["tasks"].as_array().unwrap().is_empty());
        assert_eq!(rows[2]["tasks"][0]["taskId"], "unbound");
        assert!(rows[2].get("projectKey").is_none());
    }

    #[test]
    fn workspace_response_preserves_execution_path_for_explicit_project_assignment() {
        let mut moved = task("moved", Some("target"));
        moved.workspace_path = "/other/checkout".to_owned();
        moved.group_workspace_path = Some("/srv/work".to_owned());
        moved.preserve_execution_path = true;
        let rows = workspace_response(vec![moved], vec![project("target", None)]);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["workspacePath"],
            crate::runtime_work::util::normalize_workspace_path("/srv/work")
        );
        assert_eq!(
            rows[0]["tasks"][0]["workspacePath"],
            crate::runtime_work::util::normalize_workspace_path("/other/checkout")
        );
    }

    #[test]
    fn workspace_response_deduplicates_the_same_project_record() {
        let rows = workspace_response(
            Vec::new(),
            vec![project("project-a", None), project("project-a", None)],
        );
        assert_eq!(rows.len(), 1);
    }
}
