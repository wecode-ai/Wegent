// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::cmp::Reverse;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::util::{infer_workspace_kind, integer_field, now_ms, string_field, workspace_label};

const DEFAULT_CODEX_SESSION_LIMIT: u64 = 100;

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
        }
    }

    pub fn from_thread(
        thread: &Value,
        local_link: Option<RuntimeTaskLink>,
        workspace_path: String,
    ) -> Self {
        let thread_id = string_field(thread, "id").unwrap_or_default();
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
            status: local_link
                .as_ref()
                .map(|link| link.status.clone())
                .or_else(|| string_field(thread, "status"))
                .unwrap_or_else(|| "active".to_owned()),
            running: local_link
                .as_ref()
                .map(|link| link.running)
                .unwrap_or_else(|| {
                    string_field(thread, "status")
                        .is_some_and(|status| status.eq_ignore_ascii_case("running"))
                }),
            created_at: integer_field(thread, "createdAt").unwrap_or_else(now_ms),
            updated_at: integer_field(thread, "updatedAt").unwrap_or_else(now_ms),
        }
    }
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
        }
    }
}

pub(crate) fn thread_list_params(archived: bool) -> Value {
    json!({
        "limit": DEFAULT_CODEX_SESSION_LIMIT,
        "archived": archived,
        "sortDirection": "desc",
        "sortKey": "updated_at",
        "useStateDbOnly": true,
    })
}

pub(crate) fn workspace_response(links: Vec<RuntimeTaskLink>) -> Vec<Value> {
    let mut groups: std::collections::HashMap<String, Vec<RuntimeTaskLink>> =
        std::collections::HashMap::new();
    for link in links {
        groups
            .entry(link.workspace_path.clone())
            .or_default()
            .push(link);
    }

    let mut workspaces = groups
        .into_iter()
        .map(|(workspace_path, mut local_tasks)| {
            local_tasks.sort_by_key(|link| Reverse(link.updated_at));
            json!({
                "workspacePath": workspace_path,
                "workspaceKind": infer_workspace_kind(&workspace_path),
                "label": workspace_label(&workspace_path),
                "workspaceSource": "local_path",
                "localTasks": local_tasks
                    .into_iter()
                    .map(local_task_json)
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| {
        right["localTasks"][0]["updatedAt"]
            .as_i64()
            .cmp(&left["localTasks"][0]["updatedAt"].as_i64())
    });
    workspaces
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
        let entry = groups
            .entry(link.workspace_path.clone())
            .or_insert_with(|| (workspace_label(&link.workspace_path), 0));
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
        "localTaskId": link.local_task_id,
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
    json!({
        "localTaskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "title": link.title,
        "runtime": link.runtime,
        "workspaceKind": infer_workspace_kind(&link.workspace_path),
        "runtimeHandle": {
            "threadId": link.thread_id,
        },
        "running": link.running,
        "status": link.status,
        "createdAt": link.created_at,
        "updatedAt": link.updated_at,
    })
}

fn archived_conversation_item(link: &RuntimeTaskLink, device_id: &str) -> Value {
    json!({
        "id": link.local_task_id,
        "localTaskId": link.local_task_id,
        "title": link.title,
        "projectKey": link.workspace_path,
        "projectName": workspace_label(&link.workspace_path),
        "workspacePath": link.workspace_path,
        "workspaceKind": infer_workspace_kind(&link.workspace_path),
        "deviceId": device_id,
        "deviceName": device_id,
        "source": "local",
        "runtime": link.runtime,
        "createdAt": link.created_at,
        "updatedAt": link.updated_at,
    })
}

fn runtime_task_address(link: &RuntimeTaskLink, device_id: &str) -> Value {
    json!({
        "deviceId": device_id,
        "workspacePath": link.workspace_path,
        "localTaskId": link.local_task_id,
    })
}
