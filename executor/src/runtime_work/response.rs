// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{cmp::Reverse, collections::HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::util::{
    infer_workspace_kind, infer_worktree_id, normalize_workspace_path, now_ms, path_is_within,
    string_field, timestamp_ms_field, workspace_group_path, workspace_label, workspace_task_path,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct RuntimeTaskLink {
    pub local_task_id: String,
    pub thread_id: Option<String>,
    pub workspace_path: String,
    pub title: String,
    pub runtime: String,
    pub status: String,
    pub running: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub runtime_handle: Value,
    pub parent: Option<Value>,
    pub ephemeral: bool,
    #[serde(skip)]
    pub list_order: Option<usize>,
    #[serde(skip)]
    pub group_workspace_path: Option<String>,
}

impl RuntimeTaskLink {
    pub fn new_pending(local_task_id: String, workspace_path: String, title: String) -> Self {
        Self {
            local_task_id,
            thread_id: None,
            workspace_path,
            title,
            runtime: "codex".to_owned(),
            status: "running".to_owned(),
            running: true,
            created_at: now_ms(),
            updated_at: now_ms(),
            runtime_handle: json!({}),
            parent: None,
            ephemeral: false,
            list_order: None,
            group_workspace_path: None,
        }
    }

    pub fn new_imported(
        local_task_id: String,
        workspace_path: String,
        title: String,
        runtime: String,
        runtime_handle: Value,
        parent: Value,
    ) -> Self {
        Self {
            local_task_id,
            thread_id: None,
            workspace_path,
            title,
            runtime,
            status: "active".to_owned(),
            running: false,
            created_at: now_ms(),
            updated_at: now_ms(),
            runtime_handle,
            parent: Some(parent),
            ephemeral: false,
            list_order: None,
            group_workspace_path: None,
        }
    }

    pub fn from_thread_metadata(
        thread: &Value,
        local_link: Option<RuntimeTaskLink>,
        workspace_path: String,
    ) -> Self {
        let thread_id = string_field(thread, "id").unwrap_or_default();
        let local_archived = local_link
            .as_ref()
            .is_some_and(|link| link.status == "archived");
        let local_terminal_status = local_link
            .as_ref()
            .and_then(|link| local_terminal_status_if_current(link, thread));
        let local_running = local_link.as_ref().is_some_and(|link| link.running);
        let status = if local_archived {
            "archived".to_owned()
        } else if local_running {
            "running".to_owned()
        } else if let Some(status) = &local_terminal_status {
            status.clone()
        } else {
            thread_status(thread)
        };
        let running = !local_archived
            && local_terminal_status.is_none()
            && (local_running || normalized_running_status(&status));
        Self {
            local_task_id: local_link
                .as_ref()
                .map(|link| link.local_task_id.clone())
                .unwrap_or_else(|| thread_id.clone()),
            thread_id: Some(thread_id),
            workspace_path,
            title: local_link
                .as_ref()
                .map(|link| link.title.clone())
                .or_else(|| string_field(thread, "name"))
                .or_else(|| string_field(thread, "preview"))
                .unwrap_or_else(|| "Codex conversation".to_owned()),
            runtime: "codex".to_owned(),
            status,
            running,
            created_at: timestamp_ms_field(thread, "createdAt").unwrap_or_else(now_ms),
            updated_at: timestamp_ms_field(thread, "updatedAt").unwrap_or_else(now_ms),
            runtime_handle: local_link
                .as_ref()
                .map(|link| link.runtime_handle.clone())
                .unwrap_or_else(|| json!({})),
            parent: local_link.as_ref().and_then(|link| link.parent.clone()),
            ephemeral: local_link.as_ref().is_some_and(|link| link.ephemeral),
            list_order: None,
            group_workspace_path: None,
        }
    }

    pub fn list_summary(&self) -> Self {
        Self {
            local_task_id: self.local_task_id.clone(),
            thread_id: self.thread_id.clone(),
            workspace_path: self.workspace_path.clone(),
            title: self.title.clone(),
            runtime: self.runtime.clone(),
            status: self.status.clone(),
            running: self.running,
            created_at: self.created_at,
            updated_at: self.updated_at,
            runtime_handle: Value::Object(runtime_handle_list_summary_map(&self.runtime_handle)),
            parent: self.parent.clone(),
            ephemeral: self.ephemeral,
            list_order: self.list_order,
            group_workspace_path: self.group_workspace_path.clone(),
        }
    }
}

fn local_terminal_status_if_current(link: &RuntimeTaskLink, thread: &Value) -> Option<String> {
    if link.running || !is_terminal_status(&link.status) {
        return None;
    }
    let local_is_current = timestamp_ms_field(thread, "updatedAt")
        .map(|thread_updated_at| link.updated_at >= thread_updated_at)
        .unwrap_or(true);
    local_is_current.then(|| link.status.clone())
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
        "done" | "complete" | "completed" | "failed" | "error" | "cancelled" | "canceled"
    )
}

impl Default for RuntimeTaskLink {
    fn default() -> Self {
        Self {
            local_task_id: String::new(),
            thread_id: None,
            workspace_path: String::new(),
            title: String::new(),
            runtime: "codex".to_owned(),
            status: "active".to_owned(),
            running: false,
            created_at: now_ms(),
            updated_at: now_ms(),
            runtime_handle: json!({}),
            parent: None,
            ephemeral: false,
            list_order: None,
            group_workspace_path: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct RuntimeWorkspaceLink {
    pub workspace_path: String,
    pub title: String,
    pub runtime: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub workspace_source: String,
    pub remote_host_id: Option<String>,
}

impl Default for RuntimeWorkspaceLink {
    fn default() -> Self {
        Self {
            workspace_path: String::new(),
            title: String::new(),
            runtime: "codex".to_owned(),
            created_at: now_ms(),
            updated_at: now_ms(),
            workspace_source: "local".to_owned(),
            remote_host_id: None,
        }
    }
}

pub(crate) fn workspace_response(
    links: Vec<RuntimeTaskLink>,
    workspaces: Vec<RuntimeWorkspaceLink>,
) -> Vec<Value> {
    let mut groups: HashMap<String, (Option<RuntimeWorkspaceLink>, Vec<RuntimeTaskLink>)> =
        HashMap::new();
    let mut workspace_order = HashMap::<String, usize>::new();
    for (index, mut workspace) in workspaces.into_iter().enumerate() {
        let group_path = normalize_workspace_path(&workspace.workspace_path);
        workspace_order
            .entry(group_path.clone())
            .and_modify(|order| *order = (*order).min(index))
            .or_insert(index);
        workspace.workspace_path = group_path.clone();
        groups
            .entry(group_path)
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

    let mut workspace_roots = groups.keys().cloned().collect::<Vec<_>>();
    workspace_roots.sort_by_key(|root| Reverse(root.len()));
    for mut link in links {
        let normalized_link_path = link
            .group_workspace_path
            .clone()
            .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
        let group_path = workspace_roots
            .iter()
            .find(|root| path_is_within(root, &normalized_link_path))
            .cloned()
            .unwrap_or(normalized_link_path);
        link.workspace_path = workspace_task_path(&link.workspace_path, &group_path);
        groups
            .entry(group_path)
            .or_insert_with(|| (None, Vec::new()))
            .1
            .push(link);
    }

    let mut workspaces = groups
        .into_iter()
        .map(|(workspace_path, (workspace, mut tasks))| {
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
            let mut workspace_json = json!({
                "workspacePath": workspace_path,
                "workspaceKind": infer_workspace_kind(&workspace_path),
                "label": label,
                "workspaceSource": workspace_source,
                "tasks": tasks
                    .into_iter()
                    .map(local_task_json)
                    .collect::<Vec<_>>(),
                "updatedAt": updated_at,
            });
            if let Some(remote_host_id) = remote_host_id {
                workspace_json["remoteHostId"] = Value::String(remote_host_id);
            }
            (
                workspace_json,
                workspace_order.get(&workspace_path).copied(),
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

fn compare_runtime_task_links(
    left: &RuntimeTaskLink,
    right: &RuntimeTaskLink,
) -> std::cmp::Ordering {
    match (left.list_order, right.list_order) {
        (Some(left_order), Some(right_order)) => left_order
            .cmp(&right_order)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.local_task_id.cmp(&right.local_task_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.local_task_id.cmp(&right.local_task_id)),
    }
}

pub(crate) fn archived_conversations_response(
    mut links: Vec<RuntimeTaskLink>,
    device_id: &str,
) -> Value {
    links.sort_by_key(|link| Reverse(link.updated_at));
    let items = links
        .iter()
        .map(|link| archived_conversation_item(link, device_id))
        .collect::<Vec<_>>();
    let total = items.len();

    let mut groups = std::collections::HashMap::<String, (String, u64)>::new();
    for link in &links {
        let project_key = archived_conversation_project_key(link);
        let entry = groups
            .entry(project_key.clone())
            .or_insert_with(|| (workspace_label(&project_key), 0));
        entry.1 += 1;
    }
    let mut project_groups = groups
        .into_iter()
        .map(|(project_key, (project_name, count))| {
            json!({
                "projectKey": project_key,
                "projectName": project_name,
                "count": count,
            })
        })
        .collect::<Vec<_>>();
    project_groups.sort_by(|left, right| {
        left["projectName"]
            .as_str()
            .unwrap_or("")
            .cmp(right["projectName"].as_str().unwrap_or(""))
    });

    json!({
        "success": true,
        "items": items,
        "projectGroups": project_groups,
        "total": total,
    })
}

pub(crate) struct SearchResultMatch {
    pub snippet: String,
    pub match_start: usize,
    pub match_end: usize,
    pub message_id: String,
    pub message_role: String,
    pub message_created_at: Value,
}

pub(crate) fn search_result_item(
    link: &RuntimeTaskLink,
    device_id: &str,
    result_match: SearchResultMatch,
) -> Value {
    json!({
        "address": runtime_task_address(link, device_id),
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "title": link.title,
        "snippet": result_match.snippet,
        "matchStart": result_match.match_start,
        "matchEnd": result_match.match_end,
        "messageId": result_match.message_id,
        "messageRole": result_match.message_role,
        "messageCreatedAt": result_match.message_created_at,
        "updatedAt": link.updated_at,
        "deviceName": device_id,
        "project": Value::Null,
    })
}

fn local_task_json(link: RuntimeTaskLink) -> Value {
    let runtime_handle = runtime_handle_with_thread_id(&link);
    let mut task = Map::new();
    task.insert("taskId".to_owned(), Value::String(link.local_task_id));
    task.insert(
        "workspacePath".to_owned(),
        Value::String(link.workspace_path.clone()),
    );
    task.insert("title".to_owned(), Value::String(link.title));
    task.insert("runtime".to_owned(), Value::String(link.runtime));
    task.insert(
        "workspaceKind".to_owned(),
        Value::String(infer_workspace_kind(&link.workspace_path).to_owned()),
    );
    if let Some(worktree_id) = infer_worktree_id(&link.workspace_path) {
        task.insert("worktreeId".to_owned(), Value::String(worktree_id));
    }
    task.insert("runtimeHandle".to_owned(), Value::Object(runtime_handle));
    task.insert("running".to_owned(), Value::Bool(link.running));
    task.insert("status".to_owned(), Value::String(link.status));
    task.insert(
        "createdAt".to_owned(),
        Value::Number(link.created_at.into()),
    );
    task.insert(
        "updatedAt".to_owned(),
        Value::Number(link.updated_at.into()),
    );
    if let Some(parent) = link.parent {
        task.insert("parent".to_owned(), parent);
    }
    Value::Object(task)
}

fn archived_conversation_item(link: &RuntimeTaskLink, device_id: &str) -> Value {
    let project_key = archived_conversation_project_key(link);
    let project_name = workspace_label(&project_key);
    json!({
        "id": link.local_task_id,
        "taskId": link.local_task_id,
        "threadId": link.thread_id,
        "title": link.title,
        "projectKey": project_key,
        "projectName": project_name,
        "workspacePath": link.workspace_path,
        "workspaceKind": infer_workspace_kind(&link.workspace_path),
        "runtimeHandle": archived_cleanup_runtime_handle(link),
        "deviceId": device_id,
        "deviceName": device_id,
        "source": "local",
        "runtime": link.runtime,
        "createdAt": link.created_at,
        "updatedAt": link.updated_at,
    })
}

fn archived_conversation_project_key(link: &RuntimeTaskLink) -> String {
    link.group_workspace_path
        .clone()
        .unwrap_or_else(|| workspace_group_path(&link.workspace_path))
}

fn archived_cleanup_runtime_handle(link: &RuntimeTaskLink) -> Value {
    let mut paths = Vec::new();
    collect_cleanup_attachment_paths(&link.runtime_handle, &mut paths);
    if let Some(parent) = &link.parent {
        collect_cleanup_attachment_paths(parent, &mut paths);
    }
    paths.sort();
    paths.dedup();
    json!({
        "cleanupAttachments": paths
            .into_iter()
            .map(|path| json!({"local_path": path}))
            .collect::<Vec<_>>(),
    })
}

fn collect_cleanup_attachment_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_cleanup_attachment_paths(item, paths);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(
                    key.as_str(),
                    "local_path" | "localPath" | "local_preview_url" | "localPreviewUrl"
                ) {
                    if let Some(path) = value
                        .as_str()
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                    {
                        paths.push(path.to_owned());
                    }
                }
                collect_cleanup_attachment_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn runtime_task_address(link: &RuntimeTaskLink, device_id: &str) -> Value {
    let mut address = Map::new();
    address.insert("deviceId".to_owned(), Value::String(device_id.to_owned()));
    address.insert(
        "workspacePath".to_owned(),
        Value::String(link.workspace_path.clone()),
    );
    address.insert(
        "taskId".to_owned(),
        Value::String(link.local_task_id.clone()),
    );
    address.insert(
        "runtimeHandle".to_owned(),
        Value::Object(runtime_handle_with_thread_id(link)),
    );
    Value::Object(address)
}

fn runtime_handle_with_thread_id(link: &RuntimeTaskLink) -> Map<String, Value> {
    let mut runtime_handle = runtime_handle_list_summary_map(&link.runtime_handle);
    runtime_handle.insert(
        "threadId".to_owned(),
        link.thread_id
            .as_ref()
            .map(|thread_id| Value::String(thread_id.clone()))
            .unwrap_or(Value::Null),
    );
    runtime_handle
}

pub(crate) fn runtime_handle_list_summary_map(runtime_handle: &Value) -> Map<String, Value> {
    runtime_handle
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| !runtime_handle_list_payload_key(key))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn runtime_handle_list_payload_key(key: &str) -> bool {
    matches!(
        key,
        "message"
            | "messages"
            | "cachedMessage"
            | "cachedMessages"
            | "cached_message"
            | "cached_messages"
    )
}

fn thread_status(thread: &Value) -> String {
    match string_field(thread, "status")
        .unwrap_or_else(|| "active".to_owned())
        .replace(['_', '-'], "")
        .to_ascii_lowercase()
        .as_str()
    {
        "archived" => "archived",
        "failed" | "error" => "failed",
        _ => "active",
    }
    .to_owned()
}

fn normalized_running_status(status: &str) -> bool {
    matches!(
        status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
        "running" | "inprogress" | "busy" | "pending"
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn workspace_response_omits_runtime_handle_messages_from_task_list() {
        let task = RuntimeTaskLink {
            local_task_id: "task-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            workspace_path: "/tmp/project".to_owned(),
            title: "Large output".to_owned(),
            runtime_handle: json!({
                "threadId": "stale-thread",
                "modelSelection": {"model": "gpt-5.5"},
                "messages": [
                    {
                        "role": "assistant",
                        "blocks": [
                            {
                                "type": "tool_use",
                                "tool_output": "x".repeat(1024),
                            }
                        ],
                    }
                ],
            }),
            ..RuntimeTaskLink::default()
        };

        let workspaces = workspace_response(vec![task], Vec::new());
        let handle = &workspaces[0]["tasks"][0]["runtimeHandle"];

        assert_eq!(handle["threadId"], "thread-1");
        assert_eq!(handle["modelSelection"]["model"], "gpt-5.5");
        assert!(handle.get("messages").is_none());
    }

    #[test]
    fn thread_list_running_status_does_not_drive_task_running() {
        let link = RuntimeTaskLink::from_thread_metadata(
            &json!({
                "id": "thread-1",
                "status": "running",
                "cwd": "/workspace/project",
            }),
            None,
            "/workspace/project".to_owned(),
        );

        assert_eq!(link.status, "active");
        assert!(!link.running);
    }

    #[test]
    fn search_result_address_omits_runtime_handle_messages() {
        let task = RuntimeTaskLink {
            local_task_id: "task-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            workspace_path: "/tmp/project".to_owned(),
            title: "Large output".to_owned(),
            runtime_handle: json!({
                "messages": [{"content": "large cached transcript"}],
                "executorSession": {"agent": "Codex"},
            }),
            ..RuntimeTaskLink::default()
        };

        let item = search_result_item(
            &task,
            "device-1",
            SearchResultMatch {
                snippet: "Large".to_owned(),
                match_start: 0,
                match_end: 5,
                message_id: String::new(),
                message_role: "title".to_owned(),
                message_created_at: Value::Null,
            },
        );
        let handle = &item["address"]["runtimeHandle"];

        assert_eq!(handle["threadId"], "thread-1");
        assert_eq!(handle["executorSession"]["agent"], "Codex");
        assert!(handle.get("messages").is_none());
    }
}
