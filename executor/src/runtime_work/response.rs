// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cmp::Reverse,
    fs,
    path::{Path, PathBuf},
};

mod workspaces;
pub(crate) use workspaces::workspace_response;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::util::{
    infer_workspace_kind, infer_worktree_id, now_ms, string_field, timestamp_ms_field,
    workspace_group_path, workspace_label,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSupervisorSuggestion {
    pub id: String,
    pub message: String,
    pub rationale: String,
    pub status: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub source_turn_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSupervisorState {
    pub mode: String,
    pub status: String,
    pub instructions: String,
    #[serde(default)]
    pub model_selection: Option<Value>,
    #[serde(default = "default_supervisor_interval_seconds")]
    pub interval_seconds: u64,
    pub last_evaluated_at: Option<i64>,
    #[serde(default)]
    pub last_content_hash: Option<String>,
    pub last_error: Option<String>,
    pub suggestions: Vec<RuntimeSupervisorSuggestion>,
}

fn default_supervisor_interval_seconds() -> u64 {
    30
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct RuntimeTaskLink {
    pub local_task_id: String,
    pub thread_id: Option<String>,
    pub workspace_path: String,
    pub title: String,
    pub runtime: String,
    pub status: String,
    #[serde(skip)]
    pub running: bool,
    pub continuable: bool,
    pub thread_status: String,
    pub turn_status: Option<String>,
    pub goal_status: Option<String>,
    pub goal_execution_status: Option<String>,
    pub interaction_status: Option<String>,
    pub supervisor: Option<RuntimeSupervisorState>,
    #[serde(skip)]
    pub git_info: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: i64,
    pub completed_at: Option<i64>,
    pub runtime_handle: Value,
    pub parent: Option<Value>,
    pub ephemeral: bool,
    pub runtime_project_key: Option<String>,
    pub runtime_workspace_roots: Vec<String>,
    pub project_instructions: String,
    pub project_plugin_ids: Vec<String>,
    #[serde(skip)]
    pub list_order: Option<usize>,
    #[serde(skip)]
    pub sidebar_order: Option<usize>,
    #[serde(skip)]
    pub group_workspace_path: Option<String>,
    #[serde(skip)]
    pub group_project_key: Option<String>,
    #[serde(skip)]
    pub preserve_execution_path: bool,
    #[serde(skip)]
    pub pinned: bool,
    #[serde(skip)]
    pub pinned_order: Option<usize>,
}

impl RuntimeTaskLink {
    pub fn new_pending(local_task_id: String, workspace_path: String, title: String) -> Self {
        Self::new_pending_with_runtime(local_task_id, workspace_path, title, "codex")
    }

    pub fn new_pending_with_runtime(
        local_task_id: String,
        workspace_path: String,
        title: String,
        runtime: impl Into<String>,
    ) -> Self {
        let runtime = runtime.into();
        let now = now_ms();
        Self {
            local_task_id,
            thread_id: None,
            workspace_path,
            title,
            runtime: runtime.clone(),
            status: "active".to_owned(),
            running: false,
            continuable: true,
            thread_status: "notLoaded".to_owned(),
            turn_status: None,
            goal_status: None,
            goal_execution_status: None,
            interaction_status: None,
            supervisor: None,
            git_info: None,
            created_at: now,
            updated_at: now,
            recency_at: now,
            completed_at: None,
            runtime_handle: json!({ "runtime": runtime }),
            parent: None,
            ephemeral: false,
            runtime_project_key: None,
            runtime_workspace_roots: Vec::new(),
            project_instructions: String::new(),
            project_plugin_ids: Vec::new(),
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            preserve_execution_path: false,
            pinned: false,
            pinned_order: None,
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
        let now = now_ms();
        Self {
            local_task_id,
            thread_id: None,
            workspace_path,
            title,
            runtime,
            status: "active".to_owned(),
            running: false,
            continuable: true,
            thread_status: "notLoaded".to_owned(),
            turn_status: None,
            goal_status: None,
            goal_execution_status: None,
            interaction_status: None,
            supervisor: None,
            git_info: None,
            created_at: now,
            updated_at: now,
            recency_at: now,
            completed_at: None,
            runtime_handle,
            parent: Some(parent),
            ephemeral: false,
            runtime_project_key: None,
            runtime_workspace_roots: Vec::new(),
            project_instructions: String::new(),
            project_plugin_ids: Vec::new(),
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            preserve_execution_path: false,
            pinned: false,
            pinned_order: None,
        }
    }

    pub fn from_thread_metadata(
        thread: &Value,
        local_link: Option<RuntimeTaskLink>,
        workspace_path: String,
        execution_running: bool,
    ) -> Self {
        let thread_id = string_field(thread, "id").unwrap_or_default();
        let local_archived = local_link
            .as_ref()
            .is_some_and(|link| link.status == "archived");
        let goal_status = local_link
            .as_ref()
            .and_then(|link| link.goal_status.clone());
        let supervisor = local_link.as_ref().and_then(|link| link.supervisor.clone());
        let git_info = thread
            .get("gitInfo")
            .or_else(|| thread.get("git_info"))
            .filter(|value| !value.is_null())
            .cloned()
            .or_else(|| local_link.as_ref().and_then(|link| link.git_info.clone()));
        let local_completed_at = local_link.as_ref().and_then(|link| link.completed_at);
        let created_at = timestamp_ms_field(thread, "createdAt").unwrap_or_else(now_ms);
        let recency_at = timestamp_ms_field(thread, "recencyAt")
            .or_else(|| timestamp_ms_field(thread, "recency_at"))
            .or_else(|| local_link.as_ref().map(|link| link.recency_at))
            .unwrap_or(created_at);
        let local_settled_status = local_link.as_ref().and_then(local_settled_status);
        let provider_turn_running =
            codex_thread_has_in_progress_turn_after(thread, local_completed_at);
        let running = !local_archived && (execution_running || provider_turn_running);
        let mut status = merged_task_status(thread, running, local_archived);
        let mut thread_status =
            codex_thread_status_type(thread).unwrap_or_else(|| "notLoaded".to_owned());
        let mut turn_status = task_turn_status(thread, running);
        if !running {
            if let Some(local_settled_status) = local_settled_status.as_deref() {
                status = local_settled_status.to_owned();
                if local_settled_status == "cancelled" {
                    thread_status = "idle".to_owned();
                    turn_status = Some("interrupted".to_owned());
                } else if local_settled_status == "done" {
                    thread_status = "idle".to_owned();
                    turn_status = Some("completed".to_owned());
                } else {
                    thread_status = local_settled_status.to_owned();
                    turn_status = Some(local_settled_status.to_owned());
                }
            } else {
                if runtime_status_is_running(&status) {
                    status = "active".to_owned();
                }
                if runtime_status_is_running(&thread_status) {
                    thread_status = "idle".to_owned();
                }
                if turn_status
                    .as_deref()
                    .is_some_and(runtime_status_is_running)
                {
                    turn_status = Some("completed".to_owned());
                }
            }
        }
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
            continuable: !local_archived,
            thread_status,
            turn_status,
            goal_status,
            goal_execution_status: local_link
                .as_ref()
                .and_then(|link| link.goal_execution_status.clone()),
            interaction_status: local_link
                .as_ref()
                .and_then(|link| link.interaction_status.clone()),
            supervisor,
            git_info,
            created_at,
            updated_at: if running {
                timestamp_ms_field(thread, "updatedAt")
                    .unwrap_or_else(now_ms)
                    .max(local_link.as_ref().map_or(0, |link| link.updated_at))
            } else {
                local_completed_at
                    .or_else(|| timestamp_ms_field(thread, "updatedAt"))
                    .unwrap_or_else(now_ms)
            },
            recency_at,
            completed_at: if running || local_settled_status.is_some() {
                local_completed_at
            } else {
                local_completed_at.or_else(|| timestamp_ms_field(thread, "updatedAt"))
            },
            runtime_handle: local_link
                .as_ref()
                .map(|link| link.runtime_handle.clone())
                .unwrap_or_else(|| json!({})),
            parent: local_link.as_ref().and_then(|link| link.parent.clone()),
            ephemeral: local_link.as_ref().is_some_and(|link| link.ephemeral),
            runtime_project_key: local_link
                .as_ref()
                .and_then(|link| link.runtime_project_key.clone()),
            runtime_workspace_roots: local_link
                .as_ref()
                .map(|link| link.runtime_workspace_roots.clone())
                .unwrap_or_default(),
            project_instructions: local_link
                .as_ref()
                .map(|link| link.project_instructions.clone())
                .unwrap_or_default(),
            project_plugin_ids: local_link
                .as_ref()
                .map(|link| link.project_plugin_ids.clone())
                .unwrap_or_default(),
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            preserve_execution_path: false,
            pinned: false,
            pinned_order: None,
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
            continuable: self.continuable,
            thread_status: self.thread_status.clone(),
            turn_status: self.turn_status.clone(),
            goal_status: self.goal_status.clone(),
            goal_execution_status: self.goal_execution_status.clone(),
            interaction_status: self.interaction_status.clone(),
            supervisor: self.supervisor.clone(),
            git_info: self.git_info.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            recency_at: self.recency_at,
            completed_at: self.completed_at,
            runtime_handle: Value::Object(runtime_handle_list_summary_map(&self.runtime_handle)),
            parent: self.parent.clone(),
            ephemeral: self.ephemeral,
            runtime_project_key: self.runtime_project_key.clone(),
            runtime_workspace_roots: self.runtime_workspace_roots.clone(),
            project_instructions: self.project_instructions.clone(),
            project_plugin_ids: self.project_plugin_ids.clone(),
            list_order: self.list_order,
            sidebar_order: self.sidebar_order,
            group_workspace_path: self.group_workspace_path.clone(),
            group_project_key: self.group_project_key.clone(),
            preserve_execution_path: self.preserve_execution_path,
            pinned: self.pinned,
            pinned_order: self.pinned_order,
        }
    }
}

fn git_workspace_info(workspace_path: &str) -> (Option<String>, Option<String>) {
    let Some((git_dir, common_git_dir)) = git_directories_at_workspace(workspace_path) else {
        return (None, None);
    };
    let branch = fs::read_to_string(git_dir.join("HEAD"))
        .ok()
        .and_then(|head| {
            head.trim()
                .strip_prefix("ref: refs/heads/")
                .map(str::to_owned)
        });
    let origin_url = fs::read_to_string(common_git_dir.join("config"))
        .ok()
        .and_then(|config| git_origin_url(&config));
    (branch, origin_url)
}

fn git_info_for_workspace(mut git_info: Option<Value>, workspace_path: &str) -> Option<Value> {
    let (current_branch, origin_url) = git_workspace_info(workspace_path);
    if current_branch.is_none() && origin_url.is_none() {
        return git_info;
    }
    if !git_info.as_ref().is_some_and(Value::is_object) {
        git_info = Some(json!({}));
    }
    let fields = git_info.as_mut().and_then(Value::as_object_mut)?;
    if let Some(current_branch) = current_branch {
        fields.insert("currentBranch".to_owned(), Value::String(current_branch));
    }
    if let Some(origin_url) = origin_url {
        fields.insert("originUrl".to_owned(), Value::String(origin_url));
    }
    git_info
}

fn git_directories_at_workspace(workspace_path: &str) -> Option<(PathBuf, PathBuf)> {
    let workspace = Path::new(workspace_path);
    let dot_git = workspace.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let pointer = fs::read_to_string(&dot_git).ok()?;
        let path = pointer.trim().strip_prefix("gitdir:")?.trim();
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    };
    let common_git_dir = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                git_dir.join(path)
            }
        })
        .unwrap_or_else(|| git_dir.clone());
    Some((git_dir, common_git_dir))
}

fn git_origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line.eq_ignore_ascii_case("[remote \"origin\"]");
            continue;
        }
        if !in_origin {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            return Some(value.trim().to_owned()).filter(|value| !value.is_empty());
        }
    }
    None
}

impl Default for RuntimeTaskLink {
    fn default() -> Self {
        let now = now_ms();
        Self {
            local_task_id: String::new(),
            thread_id: None,
            workspace_path: String::new(),
            title: String::new(),
            runtime: "codex".to_owned(),
            status: "active".to_owned(),
            running: false,
            continuable: true,
            thread_status: "notLoaded".to_owned(),
            turn_status: None,
            goal_status: None,
            goal_execution_status: None,
            interaction_status: None,
            supervisor: None,
            git_info: None,
            created_at: now,
            updated_at: now,
            recency_at: now,
            completed_at: None,
            runtime_handle: json!({}),
            parent: None,
            ephemeral: false,
            runtime_project_key: None,
            runtime_workspace_roots: Vec::new(),
            project_instructions: String::new(),
            project_plugin_ids: Vec::new(),
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            preserve_execution_path: false,
            pinned: false,
            pinned_order: None,
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
    pub project_key: String,
    pub project_kind: String,
    pub project_source: String,
    pub owner_project_key: Option<String>,
    pub project_roots: Vec<String>,
    pub project_sidebar_order: Option<usize>,
    pub project_pinned: bool,
    pub project_pinned_order: Option<usize>,
    pub project_active: bool,
    pub project_appearance: Option<Value>,
    pub default_project_space: Option<Value>,
    pub project_ai_settings: Option<Value>,
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
            project_key: String::new(),
            project_kind: "local".to_owned(),
            project_source: "legacy_root".to_owned(),
            owner_project_key: None,
            project_roots: Vec::new(),
            project_sidebar_order: None,
            project_pinned: false,
            project_pinned_order: None,
            project_active: false,
            project_appearance: None,
            default_project_space: None,
            project_ai_settings: None,
        }
    }
}

fn compare_runtime_task_links(
    left: &RuntimeTaskLink,
    right: &RuntimeTaskLink,
) -> std::cmp::Ordering {
    match (left.list_order, right.list_order) {
        (Some(left_order), Some(right_order)) => left_order
            .cmp(&right_order)
            .then_with(|| runtime_task_sort_time(right).cmp(&runtime_task_sort_time(left)))
            .then_with(|| left.local_task_id.cmp(&right.local_task_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => runtime_task_sort_time(right)
            .cmp(&runtime_task_sort_time(left))
            .then_with(|| left.local_task_id.cmp(&right.local_task_id)),
    }
}

fn runtime_task_sort_time(link: &RuntimeTaskLink) -> i64 {
    link.recency_at
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

pub(crate) fn local_task_json(link: RuntimeTaskLink) -> Value {
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
    if let Some(queue_position) = link
        .runtime_handle
        .get("queuePosition")
        .and_then(Value::as_u64)
    {
        task.insert("queuePosition".to_owned(), json!(queue_position));
    }
    task.insert("running".to_owned(), Value::Bool(link.running));
    task.insert("continuable".to_owned(), Value::Bool(link.continuable));
    task.insert(
        "threadStatus".to_owned(),
        Value::String(link.thread_status.clone()),
    );
    if let Some(turn_status) = link.turn_status.clone() {
        task.insert("turnStatus".to_owned(), Value::String(turn_status));
    }
    if let Some(goal_status) = link.goal_status.clone() {
        task.insert("goalStatus".to_owned(), Value::String(goal_status));
    }
    if let Some(goal_execution_status) = link.goal_execution_status.clone() {
        task.insert(
            "goalExecutionStatus".to_owned(),
            Value::String(goal_execution_status),
        );
    }
    task.insert(
        "interactionStatus".to_owned(),
        link.interaction_status
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    if let Some(supervisor) = link.supervisor.clone() {
        if let Ok(supervisor) = serde_json::to_value(supervisor) {
            task.insert("supervisor".to_owned(), supervisor);
        }
    }
    task.insert("pinned".to_owned(), Value::Bool(link.pinned));
    if let Some(order) = link.pinned_order {
        task.insert("pinnedOrder".to_owned(), json!(order));
    }
    if let Some(thread_id) = link.thread_id.clone() {
        task.insert("threadId".to_owned(), Value::String(thread_id));
    }
    if let Some(order) = link.sidebar_order {
        task.insert("sidebarOrder".to_owned(), json!(order));
    }
    if let Some(git_info) = link.git_info {
        task.insert("gitInfo".to_owned(), git_info);
    }
    task.insert("status".to_owned(), Value::String(link.status));
    task.insert(
        "createdAt".to_owned(),
        Value::Number(link.created_at.into()),
    );
    task.insert(
        "updatedAt".to_owned(),
        Value::Number(link.updated_at.into()),
    );
    task.insert(
        "recencyAt".to_owned(),
        Value::Number(link.recency_at.into()),
    );
    if let Some(completed_at) = link.completed_at {
        task.insert("completedAt".to_owned(), Value::Number(completed_at.into()));
    }
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
            | "collaborationMemberRuntimeProfiles"
            | "messages"
            | "userMessagePresentations"
            | "cachedMessage"
            | "cachedMessages"
            | "cached_message"
            | "cached_messages"
            | "completedTranscriptMessages"
            | "transcriptSnapshotMessages"
            | "transcriptSnapshotPagination"
    )
}

fn thread_status(thread: &Value) -> String {
    match codex_thread_status_type(thread)
        .unwrap_or_else(|| "idle".to_owned())
        .replace(['_', '-'], "")
        .to_ascii_lowercase()
        .as_str()
    {
        "archived" => "archived",
        "systemerror" | "failed" | "error" => "failed",
        "active" | "running" | "inprogress" => "running",
        _ => "active",
    }
    .to_owned()
}

fn merged_task_status(thread: &Value, running: bool, archived: bool) -> String {
    if archived {
        return "archived".to_owned();
    }
    if running {
        return "running".to_owned();
    }
    thread_status(thread)
}

fn local_settled_status(link: &RuntimeTaskLink) -> Option<String> {
    link.completed_at?;
    match link
        .status
        .replace(['_', '-'], "")
        .to_ascii_lowercase()
        .as_str()
    {
        "failed" | "error" | "systemerror" => Some("failed".to_owned()),
        "cancelled" | "canceled" | "interrupted" | "aborted" => Some("cancelled".to_owned()),
        "done" | "completed" | "complete" | "succeeded" | "success" => Some("done".to_owned()),
        _ => None,
    }
}

fn task_turn_status(thread: &Value, running: bool) -> Option<String> {
    if running {
        return Some("inProgress".to_owned());
    }
    thread
        .get("turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
        .and_then(|turn| string_field(turn, "status"))
        .map(normalize_codex_turn_status)
}

pub(super) fn codex_thread_has_in_progress_turn(thread: &Value) -> bool {
    codex_thread_has_in_progress_turn_after(thread, None)
}

fn codex_thread_has_in_progress_turn_after(
    thread: &Value,
    local_completed_at: Option<i64>,
) -> bool {
    thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|turn| {
            string_field(turn, "status").is_some_and(|status| runtime_status_is_running(&status))
        })
        .any(|turn| {
            let Some(completed_at) = local_completed_at else {
                return true;
            };
            timestamp_ms_field(turn, "startedAt")
                .or_else(|| timestamp_ms_field(turn, "started_at"))
                .is_some_and(|started_at| started_at > completed_at)
        })
}

pub(super) fn codex_thread_in_progress_turn_id(thread: &Value) -> Option<String> {
    thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find(|turn| {
            string_field(turn, "status").is_some_and(|status| runtime_status_is_running(&status))
        })
        .and_then(|turn| string_field(turn, "id"))
}

pub(super) fn codex_thread_terminal_task_status(thread: &Value) -> Option<&'static str> {
    let status = thread
        .get("turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
        .and_then(|turn| string_field(turn, "status"))?;
    match status.replace(['_', '-'], "").to_ascii_lowercase().as_str() {
        "inprogress" | "running" | "active" => None,
        "interrupted" | "cancelled" | "canceled" | "aborted" => Some("cancelled"),
        "failed" | "error" => Some("failed"),
        "completed" | "done" => Some("done"),
        _ => None,
    }
}

fn normalize_codex_turn_status(status: String) -> String {
    match status.replace(['_', '-'], "").to_ascii_lowercase().as_str() {
        "inprogress" | "running" | "active" => "inProgress".to_owned(),
        "interrupted" | "cancelled" | "canceled" | "aborted" => "interrupted".to_owned(),
        "failed" | "error" => "failed".to_owned(),
        _ => "completed".to_owned(),
    }
}

pub(super) fn runtime_status_is_running(status: &str) -> bool {
    matches!(
        status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
        "active" | "running" | "inprogress" | "busy" | "pending"
    )
}

fn codex_thread_status_type(thread: &Value) -> Option<String> {
    let status = thread.get("status")?;
    status.as_str().map(str::to_owned).or_else(|| {
        status
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests;
