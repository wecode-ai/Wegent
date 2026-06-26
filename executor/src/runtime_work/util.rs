// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::protocol::ExecutionRequest;

pub(crate) fn execution_request(payload: &Value) -> Option<ExecutionRequest> {
    payload
        .get("executionRequest")
        .or_else(|| payload.get("execution_request"))
        .cloned()
        .and_then(|value| serde_json::from_value::<ExecutionRequest>(value).ok())
}

pub(crate) fn execution_request_from_payload(
    payload: &Value,
    workspace_path: &str,
) -> ExecutionRequest {
    let mut request = ExecutionRequest {
        prompt: Value::String(
            string_field(payload, "message")
                .or_else(|| string_field(payload, "content"))
                .or_else(|| string_field(payload, "prompt"))
                .unwrap_or_default(),
        ),
        project_workspace_path: if workspace_path.is_empty() {
            None
        } else {
            Some(workspace_path.to_owned())
        },
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": string_field(payload, "modelId")
                .or_else(|| string_field(payload, "model_id"))
                .unwrap_or_else(|| "gpt-5".to_owned()),
            "api_format": "responses",
            "protocol": "openai-responses",
        }),
        ..ExecutionRequest::default()
    };
    if let Some(device_id) =
        string_field(payload, "deviceId").or_else(|| string_field(payload, "device_id"))
    {
        request.device_id = Some(device_id);
    }
    apply_runtime_payload_metadata(&mut request, payload);
    request
}

pub(crate) fn apply_runtime_payload_metadata(request: &mut ExecutionRequest, payload: &Value) {
    if prompt_is_blank(&request.prompt) {
        if let Some(content) = string_field(payload, "message")
            .or_else(|| string_field(payload, "content"))
            .or_else(|| string_field(payload, "prompt"))
        {
            request.prompt = Value::String(content);
        }
    }
    if let Some(source) = payload
        .get("source")
        .filter(|value| value.is_object())
        .cloned()
    {
        request.extra.insert("source".to_owned(), source);
    }
    if let Some(attachments) = payload
        .get("attachments")
        .filter(|value| value.is_array())
        .cloned()
    {
        request.extra.insert("attachments".to_owned(), attachments);
    }
}

pub(crate) fn runtime_task_id(payload: &Value) -> Option<String> {
    string_field(payload, "localTaskId")
        .or_else(|| string_field(payload, "local_task_id"))
        .or_else(|| {
            payload.get("address").and_then(|address| {
                string_field(address, "localTaskId")
                    .or_else(|| string_field(address, "local_task_id"))
            })
        })
}

pub(crate) fn workspace_path(payload: &Value) -> Option<String> {
    string_field(payload, "workspacePath")
        .or_else(|| string_field(payload, "workspace_path"))
        .or_else(|| {
            payload.get("address").and_then(|address| {
                string_field(address, "workspacePath")
                    .or_else(|| string_field(address, "workspace_path"))
            })
        })
}

pub(crate) fn prompt_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn raw_string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(crate) fn integer_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

pub(crate) fn timestamp_ms_field(value: &Value, key: &str) -> Option<i64> {
    integer_field(value, key).map(timestamp_ms)
}

pub(crate) fn timestamp_ms(value: i64) -> i64 {
    if value > 0 && value < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

pub(crate) fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(|value| {
        value.as_bool().or_else(|| {
            value
                .as_str()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .and_then(|value| match value.as_str() {
                    "true" | "1" | "yes" => Some(true),
                    "false" | "0" | "no" => Some(false),
                    _ => None,
                })
        })
    })
}

pub(crate) fn item_type(item: &Value) -> String {
    item.get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('_', "")
        .to_ascii_lowercase()
}

pub(crate) fn item_id(item: &Value, prefix: &str) -> String {
    string_field(item, "id").unwrap_or_else(|| format!("{prefix}-{}", now_ms()))
}

pub(crate) fn extract_text(item: &Value) -> Option<String> {
    if let Some(text) = string_field(item, "text") {
        return Some(text);
    }
    if let Some(content) = string_field(item, "content") {
        return Some(content);
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(crate) fn reasoning_content(item: &Value) -> Option<String> {
    if let Some(summary) = item.get("summary").and_then(Value::as_array) {
        let text = summary
            .iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| extract_text(value))
            })
            .collect::<Vec<_>>()
            .join("");
        if !text.is_empty() {
            return Some(text);
        }
    }
    extract_text(item)
}

pub(crate) fn workspace_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_owned())
}

pub(crate) fn workspace_group_path(path: &str) -> String {
    let normalized = normalize_workspace_path(path);
    git_common_workspace_root(&normalized)
        .or_else(|| codex_worktree_fallback_root(&normalized))
        .unwrap_or(normalized)
}

pub(crate) fn infer_workspace_kind(path: &str) -> &'static str {
    if path.contains("/Codex/") || path.contains("\\Codex\\") {
        "chat"
    } else {
        "workspace"
    }
}

pub(crate) fn normalize_device_id(device_id: String) -> String {
    if device_id.trim().is_empty() {
        "local-device".to_owned()
    } else {
        device_id
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn prompt_is_blank(value: &Value) -> bool {
    match value {
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Null => true,
        _ => false,
    }
}

pub(crate) fn normalize_workspace_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return String::new();
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

pub(crate) fn path_is_within(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches(['/', '\\']);
    let path = path.trim_end_matches(['/', '\\']);
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

fn git_common_workspace_root(path: &str) -> Option<String> {
    let mut current = PathBuf::from(path);
    loop {
        let git_marker = current.join(".git");
        if git_marker.is_dir() {
            return Some(current.to_string_lossy().into_owned());
        }
        if git_marker.is_file() {
            let git_dir = parse_gitdir_file(&git_marker, &current)?;
            let common_dir = read_common_git_dir(&git_dir).unwrap_or(git_dir);
            if common_dir.file_name().and_then(|name| name.to_str()) == Some(".git") {
                return common_dir
                    .parent()
                    .map(|root| root.to_string_lossy().into_owned());
            }
            return Some(current.to_string_lossy().into_owned());
        }
        if !current.pop() {
            return None;
        }
    }
}

fn parse_gitdir_file(git_file: &Path, worktree_root: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(git_file).ok()?;
    let raw_path = content.trim().strip_prefix("gitdir:")?.trim();
    let path = Path::new(raw_path);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        worktree_root.join(path)
    };
    Some(PathBuf::from(normalize_workspace_path(
        &resolved.to_string_lossy(),
    )))
}

fn read_common_git_dir(git_dir: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(git_dir.join("commondir")).ok()?;
    let raw_path = content.trim();
    if raw_path.is_empty() {
        return None;
    }
    let path = Path::new(raw_path);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        git_dir.join(path)
    };
    Some(PathBuf::from(normalize_workspace_path(
        &resolved.to_string_lossy(),
    )))
}

fn codex_worktree_fallback_root(path: &str) -> Option<String> {
    let mut components = Path::new(path).components().peekable();
    let mut prefix = PathBuf::new();
    while let Some(component) = components.next() {
        let component_text = component.as_os_str().to_str()?;
        prefix.push(component.as_os_str());
        if component_text != ".codex" {
            continue;
        }
        if components.next()?.as_os_str().to_str()? != "worktrees" {
            continue;
        }
        let _worktree_id = components.next()?;
        let project = components.next()?;
        prefix.push("worktrees");
        prefix.push(project.as_os_str());
        return Some(prefix.to_string_lossy().into_owned());
    }
    None
}
