// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Projection, validation, and serialization models for
//! `GET /api/runtime-work`.
//!
//! [`crate::runtime_work`] owns the request, device fan-out, and Runtime RPC.
//! This module owns the pieces that turn one device's `runtime.tasks.list`
//! acknowledgement into `RuntimeWorkListResponse` members: workspace
//! normalization and ordering, the `LocalTaskSummary` pydantic-compatible
//! projection, and the response models.

use std::collections::HashMap;

use brz_json::adapters::python_truthy;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::devices::{DeviceItem, DeviceType as ListingDeviceType};

/// `WORKTREE_ROOT_DIR`.
const WORKTREE_ROOT_DIR: &str = "worktrees";
/// `CHAT_WORKSPACE_DIR`.
const CHAT_WORKSPACE_DIR: &str = "chats";
/// `EXECUTOR_WORKSPACE_DIR`.
const EXECUTOR_WORKSPACE_DIR: &str = "workspace";
/// `EXECUTOR_ROOT_DIR_NAMES`.
const EXECUTOR_ROOT_DIR_NAMES: [&str; 2] = ["wegent-executor", ".wegent-executor"];
/// `RuntimeModelSelection` alias keys.
const MODEL_SELECTION_KEYS: [&str; 2] = ["modelSelection", "model_selection"];
/// `runtimeHandle` alias keys.
const RUNTIME_HANDLE_KEYS: [&str; 2] = ["runtimeHandle", "runtime_handle"];

/// `_runtime_device_order`: local/App devices rank first, then the remaining
/// providers by their listing position; the value is the device's rank.
pub(crate) fn runtime_device_order(devices: &[DeviceItem]) -> HashMap<String, usize> {
    let mut ordered: Vec<(usize, &DeviceItem)> = devices.iter().enumerate().collect();
    ordered.sort_by_key(|(index, device)| (device_rank(device.device_type()), *index));
    ordered
        .into_iter()
        .enumerate()
        .filter(|(_, (_, device))| !device.device_id().is_empty())
        .map(|(order, (_, device))| (device.device_id().to_string(), order))
        .collect()
}

/// `_runtime_device_type_rank` through `_device_type`, which maps App to local.
fn device_rank(device_type: ListingDeviceType) -> u8 {
    match device_type {
        ListingDeviceType::Local | ListingDeviceType::App => 0,
        ListingDeviceType::Cloud | ListingDeviceType::Remote => 1,
    }
}

/// `_runtime_workspace_order_key`.
pub(crate) fn workspace_order_key(
    entry: &((String, String), WorkspaceListing),
    device_order: &HashMap<String, usize>,
) -> (usize, usize, String) {
    let ((device_id, workspace_path), listing) = entry;
    (
        device_order
            .get(device_id)
            .copied()
            .unwrap_or(device_order.len()),
        listing.order_index,
        workspace_path.to_lowercase(),
    )
}

/// One device's workspace listing (`RuntimeWorkspaceListing`).
pub(crate) struct WorkspaceListing {
    pub(crate) reporting_device_id: String,
    pub(crate) order_index: usize,
    pub(crate) tasks: Vec<LocalTaskSummary>,
    pub(crate) label: Option<String>,
    pub(crate) workspace_source: Option<String>,
    pub(crate) remote_host_id: Option<String>,
}

impl WorkspaceListing {
    /// `_runtime_workspace_listing_rank`: the reporting device owns the
    /// workspace, or it is a remote host's workspace.
    fn rank(&self, owner_device_id: &str) -> u8 {
        u8::from(self.reporting_device_id == owner_device_id)
    }
}

/// `_list_online_runtime_workspaces`'s merge rule: keep the higher rank and
/// let the later device win a tie.
pub(crate) fn merge_listing(
    grouped: &mut HashMap<(String, String), WorkspaceListing>,
    key: (String, String),
    listing: WorkspaceListing,
) {
    if let Some(existing) = grouped.get(&key)
        && listing.rank(&key.0) < existing.rank(&key.0)
    {
        return;
    }
    grouped.insert(key, listing);
}

/// A reported workspace after `_iter_runtime_workspaces` normalization.
pub(crate) struct RawWorkspace<'a> {
    pub(crate) workspace_path: &'a str,
    tasks: &'a [Value],
    pub(crate) label: Option<String>,
    pub(crate) workspace_source: Option<String>,
    pub(crate) remote_host_id: Option<String>,
}

/// `_iter_runtime_workspaces`.
pub(crate) fn iter_runtime_workspaces(result: &Map<String, Value>) -> Vec<RawWorkspace<'_>> {
    let Some(Value::Array(items)) = result.get("workspaces") else {
        return Vec::new();
    };
    let mut normalized = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        let Some(workspace_path) =
            first_truthy(object, &["workspacePath", "workspace_path"]).and_then(Value::as_str)
        else {
            continue;
        };
        if workspace_path.trim().is_empty() {
            continue;
        }
        let Some(Value::Array(tasks)) = object.get("tasks") else {
            tracing::warn!(
                workspace_path,
                "runtime workspace is missing its tasks list"
            );
            continue;
        };
        normalized.push(RawWorkspace {
            workspace_path,
            tasks,
            label: workspace_label(object),
            workspace_source: workspace_source(object),
            remote_host_id: workspace_remote_host_id(object),
        });
    }
    normalized
}

/// One `(owner_device_id, workspace_path)` key and its merged listing.
pub(crate) type WorkspaceEntry = ((String, String), WorkspaceListing);

/// `_list_runtime_workspaces_for_device`'s result projection.
pub(crate) fn project_workspaces(
    reporting_device_id: &str,
    result: &Map<String, Value>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let mut entries = Vec::new();
    for (order_index, workspace) in iter_runtime_workspaces(result).into_iter().enumerate() {
        let Some(workspace_path) = normalize_workspace_path(workspace.workspace_path) else {
            continue;
        };
        let workspace_source = workspace.workspace_source.as_deref();
        let owner_device_id = runtime_workspace_owner_device_id(
            reporting_device_id,
            workspace_source,
            workspace.remote_host_id.as_deref(),
        );
        let mut tasks = Vec::with_capacity(workspace.tasks.len());
        for task in workspace.tasks {
            let Some(task) = task.as_object() else {
                continue;
            };
            let task_path = task_workspace_path(task, &workspace_path)?;
            tasks.push(local_task_summary(task, &task_path)?);
        }
        entries.push((
            (owner_device_id, workspace_path),
            WorkspaceListing {
                reporting_device_id: reporting_device_id.to_string(),
                order_index,
                tasks,
                label: workspace.label,
                workspace_source: workspace.workspace_source,
                remote_host_id: workspace.remote_host_id,
            },
        ));
    }
    Ok(entries)
}

/// `str(task.get("workspacePath") or workspace_path)` normalized: the task's
/// own reported path takes precedence over its workspace.
pub(crate) fn task_workspace_path(
    task: &Map<String, Value>,
    workspace_path: &str,
) -> Result<String, String> {
    let raw = match first_truthy(task, &["workspacePath", "workspace_path"]) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => crate::device_commands::python_str(value),
        None => workspace_path.to_string(),
    };
    normalize_workspace_path(&raw).ok_or_else(|| "workspacePath".to_string())
}

/// `_runtime_workspace_owner_device_id`.
fn runtime_workspace_owner_device_id(
    reporting_device_id: &str,
    workspace_source: Option<&str>,
    remote_host_id: Option<&str>,
) -> String {
    match (workspace_source, remote_host_id) {
        (Some("remote"), Some(remote_host_id)) => remote_host_id.to_string(),
        _ => reporting_device_id.to_string(),
    }
}

/// `_runtime_workspace_kind_fields_from_tasks`.
pub(crate) fn runtime_workspace_kind_fields_from_tasks(
    workspace_path: &str,
    tasks: &[LocalTaskSummary],
) -> (String, Option<String>) {
    if tasks.iter().any(|task| task.workspace_kind == "chat") {
        return ("chat".to_string(), None);
    }
    if let Some(task) = tasks.iter().find(|task| task.workspace_kind == "worktree") {
        return ("worktree".to_string(), task.worktree_id.clone());
    }
    runtime_workspace_kind_fields(workspace_path)
}

/// `_runtime_workspace_kind_fields`.
pub(crate) fn runtime_workspace_kind_fields(workspace_path: &str) -> (String, Option<String>) {
    if is_runtime_chat_workspace_path(workspace_path) {
        return ("chat".to_string(), None);
    }
    match parse_runtime_worktree_path(workspace_path) {
        Some(worktree_id) => ("worktree".to_string(), Some(worktree_id)),
        None => ("workspace".to_string(), None),
    }
}

/// `_runtime_task_kind_fields`.
pub(crate) fn runtime_task_kind_fields(
    task: &Map<String, Value>,
    workspace_path: &str,
) -> (String, Option<String>) {
    if let Some(Value::String(workspace_kind)) =
        first_truthy(task, &["workspaceKind", "workspace_kind"])
        && matches!(workspace_kind.as_str(), "workspace" | "worktree" | "chat")
    {
        let worktree_id = if workspace_kind == "worktree" {
            first_truthy(task, &["worktreeId", "worktree_id"])
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|worktree_id| !worktree_id.is_empty())
                .map(str::to_string)
        } else {
            None
        };
        return (workspace_kind.clone(), worktree_id);
    }
    runtime_workspace_kind_fields(workspace_path)
}

/// `_is_runtime_chat_workspace_path`.
fn is_runtime_chat_workspace_path(path: &str) -> bool {
    let parts = path_parts(path);
    for (index, part) in parts.iter().enumerate() {
        if *part != EXECUTOR_WORKSPACE_DIR || index + 1 >= parts.len() {
            continue;
        }
        if parts[index + 1] != CHAT_WORKSPACE_DIR {
            continue;
        }
        let previous = if index > 0 { parts[index - 1] } else { "" };
        if EXECUTOR_ROOT_DIR_NAMES.contains(&previous) || index == 0 {
            return true;
        }
    }
    parts.len() >= 2 && parts[0] == EXECUTOR_WORKSPACE_DIR && parts[1] == CHAT_WORKSPACE_DIR
}

/// `_parse_runtime_worktree_path`: the first `worktrees/<id>/<project>`
/// segment whose id is a plain path token.
fn parse_runtime_worktree_path(path: &str) -> Option<String> {
    let parts = path_parts(path);
    for (index, part) in parts.iter().enumerate() {
        if *part != WORKTREE_ROOT_DIR || index + 2 >= parts.len() {
            continue;
        }
        let worktree_id = parts[index + 1];
        if !worktree_id.is_empty()
            && worktree_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
        {
            return Some(worktree_id.to_string());
        }
    }
    None
}

/// Non-empty `/`-separated path segments.
fn path_parts(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

/// `_path_basename`.
fn path_basename(path: &str) -> &str {
    path_parts(path).pop().unwrap_or("")
}

/// `normalize_workspace_path`: strip surrounding whitespace and trailing
/// slashes; `None` when the source raises `ValueError`.
pub(crate) fn normalize_workspace_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "/" {
        return Some("/".to_string());
    }
    let stripped = trimmed.trim_end_matches('/');
    Some(if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    })
}

/// `_runtime_workspace_label`.
fn workspace_label(object: &Map<String, Value>) -> Option<String> {
    object
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_string)
}

/// `_runtime_workspace_source`.
fn workspace_source(object: &Map<String, Value>) -> Option<String> {
    let source = first_truthy(object, &["workspaceSource", "workspace_source"])?.as_str()?;
    let normalized = source.trim().to_lowercase();
    matches!(normalized.as_str(), "local" | "remote").then_some(normalized)
}

/// `_runtime_workspace_remote_host_id`.
fn workspace_remote_host_id(object: &Map<String, Value>) -> Option<String> {
    first_truthy(object, &["remoteHostId", "remote_host_id"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|host_id| !host_id.is_empty())
        .map(str::to_string)
}

/// The first alias present in the object (`pydantic` alias precedence).
fn first_present<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

/// Python `a or b` across the alias keys: the first truthy value.
fn first_truthy<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| object.get(*key).filter(|value| python_truthy(value)))
}

/// `LocalTaskSummary.model_validate` over the source's merged task dict.
pub(crate) fn local_task_summary(
    task: &Map<String, Value>,
    workspace_path: &str,
) -> Result<LocalTaskSummary, String> {
    let task_id = required_string(task, &["taskId", "localTaskId", "local_task_id"], "taskId")?;
    let (workspace_kind, worktree_id) = runtime_task_kind_fields(task, workspace_path);
    let title = required_string(task, &["title"], "title")?;
    let runtime = required_string(task, &["runtime"], "runtime")?;
    if runtime != "codex" && runtime != "claude_code" {
        return Err("runtime".to_string());
    }
    Ok(LocalTaskSummary {
        task_id,
        workspace_path: workspace_path.to_string(),
        workspace_kind,
        worktree_id,
        title,
        runtime,
        model_selection: model_selection(task)?,
        queue_position: optional_int(task, &["queuePosition", "queue_position"])?
            .map(|position| {
                if position < 1 {
                    Err("queuePosition".to_string())
                } else {
                    Ok(position)
                }
            })
            .transpose()?,
        git_info: optional_object(task, &["gitInfo", "git_info"])?,
        parent: optional_address(task, &["parent"])?,
        children: children(task)?,
        created_at: optional_timestamp(task, &["createdAt", "created_at"])?,
        updated_at: optional_timestamp(task, &["updatedAt", "updated_at"])?,
        recency_at: optional_timestamp(task, &["recencyAt", "recency_at"])?,
        completed_at: optional_timestamp(task, &["completedAt", "completed_at"])?,
        running: bool_default(task, &["running"])?,
        continuable: optional_bool(task, &["continuable"])?,
        thread_status: optional_string(task, &["threadStatus", "thread_status"])?,
        turn_status: optional_string(task, &["turnStatus", "turn_status"])?,
        goal_status: optional_string(task, &["goalStatus", "goal_status"])?,
        supervisor: optional_object(task, &["supervisor"])?,
        pinned: optional_bool(task, &["pinned"])?,
        pinned_order: optional_int(task, &["pinnedOrder", "pinned_order"])?,
        sidebar_order: optional_int(task, &["sidebarOrder", "sidebar_order"])?,
        status: optional_string(task, &["status"])?,
    })
}

/// A required string field.
fn required_string(
    object: &Map<String, Value>,
    keys: &[&str],
    field: &str,
) -> Result<String, String> {
    match first_present(object, keys) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(field.to_string()),
    }
}

/// An optional string field.
fn optional_string(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<String>, String> {
    match first_present(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// An optional integer field (`Optional[int]`).
fn optional_int(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<i64>, String> {
    match first_present(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number.as_i64().map(Some).ok_or_else(|| keys[0].to_string()),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// An optional boolean field (`Optional[bool]`).
fn optional_bool(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<bool>, String> {
    match first_present(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(Value::Number(number)) if number.as_i64() == Some(0) => Ok(Some(false)),
        Some(Value::Number(number)) if number.as_i64() == Some(1) => Ok(Some(true)),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// A boolean field with a pydantic default (`running: bool = False`): an
/// explicit JSON null is invalid, unlike an absent member.
fn bool_default(object: &Map<String, Value>, keys: &[&str]) -> Result<bool, String> {
    match first_present(object, keys) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(Value::Number(number)) if number.as_i64() == Some(0) => Ok(false),
        Some(Value::Number(number)) if number.as_i64() == Some(1) => Ok(true),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// An optional object field (`Optional[dict]`).
fn optional_object(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<Value>, String> {
    match first_present(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => Ok(Some(value.clone())),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// `Optional[str | int]` timestamp fields.
fn optional_timestamp(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<Value>, String> {
    match first_present(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::String(_)) => Ok(Some(value.clone())),
        Some(value @ Value::Number(number)) if number.is_i64() || number.is_u64() => {
            Ok(Some(value.clone()))
        }
        Some(_) => Err(keys[0].to_string()),
    }
}

/// `parent: Optional[RuntimeTaskAddressRef]`.
fn optional_address(
    task: &Map<String, Value>,
    keys: &[&str],
) -> Result<Option<TaskAddressRef>, String> {
    match first_present(task, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => task_address_ref(object).map(Some),
        Some(_) => Err(keys[0].to_string()),
    }
}

/// `children: list[RuntimeTaskAddressRef]`, defaulting to an empty list.
fn children(task: &Map<String, Value>) -> Result<Vec<TaskAddressRef>, String> {
    match first_present(task, &["children"]) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(object) => task_address_ref(object),
                _ => Err("children".to_string()),
            })
            .collect(),
        Some(_) => Err("children".to_string()),
    }
}

/// `RuntimeTaskAddress` (`RuntimeTaskAddressRef` inherits its fields).
fn task_address_ref(object: &Map<String, Value>) -> Result<TaskAddressRef, String> {
    let device_id = required_min_length(object, &["deviceId", "device_id"], "deviceId")?;
    let workspace_path = optional_string(object, &["workspacePath", "workspace_path"])?;
    let task_id = required_min_length(
        object,
        &["taskId", "localTaskId", "local_task_id"],
        "taskId",
    )?;
    let runtime_handle = optional_object(object, &["runtimeHandle", "runtime_handle"])?;
    Ok(TaskAddressRef {
        device_id,
        workspace_path,
        task_id,
        runtime_handle,
    })
}

/// A required string with pydantic's `min_length=1`.
fn required_min_length(
    object: &Map<String, Value>,
    keys: &[&str],
    field: &str,
) -> Result<String, String> {
    match first_present(object, keys) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(field.to_string()),
    }
}

/// The `LocalTaskSummary` model validator plus `RuntimeModelSelection`
/// validation.
fn model_selection(task: &Map<String, Value>) -> Result<Option<RuntimeModelSelection>, String> {
    if first_truthy(task, &MODEL_SELECTION_KEYS).is_some() {
        return optional_model_selection(first_present(task, &MODEL_SELECTION_KEYS));
    }
    if let Some(Value::Object(handle)) = first_truthy(task, &RUNTIME_HANDLE_KEYS)
        && let Some(selection) =
            first_truthy(handle, &MODEL_SELECTION_KEYS).and_then(Value::as_object)
    {
        return runtime_model_selection(selection).map(Some);
    }
    optional_model_selection(first_present(task, &MODEL_SELECTION_KEYS))
}

/// Validate the `modelSelection` value selected by the model validator.
fn optional_model_selection(
    value: Option<&Value>,
) -> Result<Option<RuntimeModelSelection>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(selection)) => runtime_model_selection(selection).map(Some),
        Some(_) => Err("modelSelection".to_string()),
    }
}

/// `RuntimeModelSelection` validation and serialization projection.
fn runtime_model_selection(
    selection: &Map<String, Value>,
) -> Result<RuntimeModelSelection, String> {
    let model_name = required_min_length(selection, &["modelName", "model_name"], "modelName")?;
    let model_type = optional_string(selection, &["modelType", "model_type"])?;
    let options = match first_present(selection, &["options"]) {
        None => Map::new(),
        Some(Value::Object(options)) => options.clone(),
        Some(_) => return Err("options".to_string()),
    };
    Ok(RuntimeModelSelection {
        model_name,
        model_type,
        options,
    })
}

/// One device workspace entry (`RuntimeDeviceWorkspace`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDeviceWorkspace {
    id: Option<i64>,
    project_id: Option<i64>,
    device_id: String,
    device_name: String,
    device_status: String,
    workspace_path: String,
    workspace_kind: String,
    worktree_id: Option<String>,
    repo_url: Option<String>,
    repo_root_fingerprint: Option<String>,
    label: Option<String>,
    workspace_source: Option<String>,
    remote_host_id: Option<String>,
    mapped: bool,
    available: bool,
    error: Option<String>,
    tasks: Vec<LocalTaskSummary>,
}

impl RuntimeDeviceWorkspace {
    /// `workspace.workspace_kind == "chat"` in `list_runtime_work`.
    pub(crate) fn is_chat(&self) -> bool {
        self.workspace_kind == "chat"
    }

    /// `RuntimeDeviceWorkspace(...)` construction in `list_runtime_work`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build(
        owner_device_id: &str,
        device: Option<&DeviceItem>,
        workspace_path: &str,
        workspace_kind: String,
        worktree_id: Option<String>,
        tasks: Vec<LocalTaskSummary>,
        label: Option<String>,
        workspace_source: Option<String>,
        remote_host_id: Option<String>,
    ) -> Self {
        let (device_name, device_status, available) = match device {
            Some(device) => {
                let name = if device.name().is_empty() {
                    owner_device_id.to_string()
                } else {
                    device.name().to_string()
                };
                let status = if device.status().is_empty() {
                    "offline".to_string()
                } else {
                    device.status().to_string()
                };
                let available = matches!(status.as_str(), "online" | "busy");
                (name, status, available)
            }
            None => (
                owner_device_id.to_string(),
                "unavailable".to_string(),
                false,
            ),
        };
        Self {
            id: None,
            project_id: None,
            device_id: owner_device_id.to_string(),
            device_name,
            device_status,
            workspace_path: workspace_path.to_string(),
            workspace_kind,
            worktree_id,
            repo_url: None,
            repo_root_fingerprint: None,
            label,
            workspace_source,
            remote_host_id,
            mapped: true,
            available,
            error: None,
            tasks,
        }
    }
}

/// One project's runtime work (`RuntimeProjectWork`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeProjectWork {
    pub(crate) project: RuntimeProjectRef,
    pub(crate) device_workspaces: Vec<RuntimeDeviceWorkspace>,
}

/// `RuntimeProjectRef`.
#[derive(Serialize)]
pub(crate) struct RuntimeProjectRef {
    id: Option<i64>,
    key: String,
    name: String,
    description: String,
    color: Option<String>,
}

impl RuntimeProjectRef {
    /// `_runtime_project_ref_from_workspace`.
    pub(crate) fn from_workspace(
        device_id: &str,
        workspace_path: &str,
        label: Option<&str>,
    ) -> Self {
        let display_name = label
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let basename = path_basename(workspace_path);
                if basename.is_empty() {
                    workspace_path.to_string()
                } else {
                    basename.to_string()
                }
            });
        Self {
            id: None,
            key: format!("{device_id}:{workspace_path}"),
            name: display_name,
            description: workspace_path.to_string(),
            color: None,
        }
    }
}

/// `RuntimeTaskAddressRef`, the parent/child task address shape.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskAddressRef {
    device_id: String,
    workspace_path: Option<String>,
    task_id: String,
    runtime_handle: Option<Value>,
}

/// `RuntimeModelSelection`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeModelSelection {
    model_name: String,
    model_type: Option<String>,
    options: Map<String, Value>,
}

/// `LocalTaskSummary` serialized with aliases and every declared member.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalTaskSummary {
    task_id: String,
    workspace_path: String,
    workspace_kind: String,
    worktree_id: Option<String>,
    title: String,
    runtime: String,
    model_selection: Option<RuntimeModelSelection>,
    queue_position: Option<i64>,
    git_info: Option<Value>,
    parent: Option<TaskAddressRef>,
    children: Vec<TaskAddressRef>,
    created_at: Option<Value>,
    updated_at: Option<Value>,
    recency_at: Option<Value>,
    completed_at: Option<Value>,
    running: bool,
    continuable: Option<bool>,
    thread_status: Option<String>,
    turn_status: Option<String>,
    goal_status: Option<String>,
    supervisor: Option<Value>,
    pinned: Option<bool>,
    pinned_order: Option<i64>,
    sidebar_order: Option<i64>,
    status: Option<String>,
}

/// `RuntimeWorkListResponse`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeWorkListResponse {
    pub(crate) projects: Vec<RuntimeProjectWork>,
    pub(crate) chats: Vec<RuntimeDeviceWorkspace>,
    pub(crate) total_tasks: usize,
}
