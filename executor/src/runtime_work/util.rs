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
) -> Result<ExecutionRequest, String> {
    let model_id = string_field(payload, "modelId")
        .or_else(|| string_field(payload, "model_id"))
        .ok_or_else(|| "modelId is required when executionRequest is not provided".to_owned())?;
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
            "model_id": model_id,
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
    apply_model_options_to_model_config(&mut request.model_config, payload);
    apply_runtime_payload_metadata(&mut request, payload);
    Ok(request)
}

fn apply_model_options_to_model_config(model_config: &mut Value, payload: &Value) {
    let Some(model_options) = payload
        .get("modelOptions")
        .or_else(|| payload.get("model_options"))
        .filter(|value| value.is_object())
    else {
        return;
    };

    let Some(config) = model_config.as_object_mut() else {
        return;
    };

    if let Some(reasoning) = reasoning_from_model_options(model_options) {
        config.insert("reasoning".to_owned(), reasoning);
    }
    if let Some(service_tier) =
        string_field(model_options, "speed").or_else(|| string_field(model_options, "service_tier"))
    {
        config.insert("service_tier".to_owned(), Value::String(service_tier));
    }
}

fn reasoning_from_model_options(model_options: &Value) -> Option<Value> {
    let effort = string_field(model_options, "reasoning");
    let summary = string_field(model_options, "summary");
    if effort.is_none() && summary.is_none() {
        return None;
    }

    let mut reasoning = serde_json::Map::new();
    if let Some(effort) = effort {
        reasoning.insert("effort".to_owned(), Value::String(effort));
    }
    if let Some(summary) = summary {
        reasoning.insert("summary".to_owned(), Value::String(summary));
    }
    Some(Value::Object(reasoning))
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
    if let Some(collaboration_mode) = payload
        .get("collaborationMode")
        .or_else(|| payload.get("collaboration_mode"))
        .or_else(|| {
            payload
                .get("modelOptions")
                .or_else(|| payload.get("model_options"))
                .and_then(|options| {
                    options
                        .get("collaborationMode")
                        .or_else(|| options.get("collaboration_mode"))
                })
        })
        .filter(|value| value.is_string())
        .cloned()
    {
        request
            .extra
            .insert("collaborationMode".to_owned(), collaboration_mode);
    }
    if let Some(message_id) = integer_field(payload, "message_id") {
        request.message_id = Some(message_id);
    }
    if let Some(turn_id) = integer_field(payload, "turn_id") {
        request.subtask_id = turn_id;
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
    value.get(key).and_then(timestamp_ms_value)
}

fn timestamp_ms_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .map(timestamp_ms)
        .or_else(|| value.as_str().and_then(parse_utc_timestamp_ms))
}

pub(crate) fn timestamp_ms(value: i64) -> i64 {
    if value > 0 && value < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn parse_utc_timestamp_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(number) = value.parse::<i64>() {
        return Some(timestamp_ms(number));
    }
    if !value.ends_with('Z') {
        return None;
    }

    let (date, time) = value[..value.len().saturating_sub(1)].split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    let (time, millis) = match time.split_once('.') {
        Some((time, fraction)) => (time, parse_millis_fraction(fraction)?),
        None => (time, 0),
    };
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }

    let days = days_from_civil(year, month, day)?;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

fn parse_millis_fraction(fraction: &str) -> Option<i64> {
    if fraction.is_empty() || !fraction.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let mut millis = 0_i64;
    for (index, ch) in fraction.chars().take(3).enumerate() {
        let digit = ch.to_digit(10)? as i64;
        millis += digit * 10_i64.pow(2 - index as u32);
    }
    Some(millis)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let month_days = days_in_month(year, month)?;
    if day > month_days {
        return None;
    }

    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn days_in_month(year: i64, month: i64) -> Option<i64> {
    Some(match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return None,
    })
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
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

pub(crate) fn codex_wrapped_item_payload(item: &Value) -> Option<&Value> {
    if matches!(item_type(item).as_str(), "responseitem" | "eventmsg") {
        return item.get("payload").filter(|payload| payload.is_object());
    }
    None
}

pub(crate) fn is_codex_tool_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandexecution"
            | "shellcall"
            | "localshellcall"
            | "functioncall"
            | "customtoolcall"
            | "dynamictoolcall"
            | "mcptoolcall"
            | "mcpcall"
            | "toolsearchcall"
            | "websearchcall"
            | "websearch"
            | "imagegeneration"
            | "imageview"
            | "sleep"
    )
}

pub(crate) fn is_codex_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "functioncalloutput" | "customtoolcalloutput" | "toolsearchoutput" | "execcommandend"
    )
}

pub(crate) fn is_likely_codex_tool_item_type(item_type: &str) -> bool {
    is_codex_tool_item_type(item_type)
        || is_codex_tool_output_item_type(item_type)
        || item_type.contains("tool")
        || item_type.contains("command")
        || item_type.contains("exec")
        || item_type.contains("mcp")
        || item_type.contains("function")
}

pub(crate) fn is_likely_codex_tool_output_item_type(item_type: &str) -> bool {
    is_codex_tool_output_item_type(item_type)
        || (is_likely_codex_tool_item_type(item_type)
            && (item_type.ends_with("end")
                || item_type.ends_with("output")
                || item_type.ends_with("result")
                || item_type.contains("complete")))
}

pub(crate) fn is_codex_context_compaction_item_type(item_type: &str) -> bool {
    matches!(item_type, "contextcompaction" | "contextcompacted")
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
    if let Some(message) = string_field(item, "message") {
        return Some(message);
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.as_str().map(str::to_owned).or_else(|| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(crate) fn completed_plan_item_text(params: &Value) -> Option<String> {
    let item = params.get("item").unwrap_or(params);
    if item_type(item).as_str() != "plan" {
        return None;
    }

    extract_text(item)
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

pub(crate) fn workspace_task_path(path: &str, group_path: &str) -> String {
    let normalized = normalize_workspace_path(path);
    if let Some((worktree_root, _)) = git_worktree_root_and_id(&normalized) {
        return worktree_root;
    }
    if let Some((worktree_root, _)) = path_worktree_root_and_id(&normalized) {
        return worktree_root;
    }
    if infer_workspace_kind(&normalized) == "chat" {
        return normalized;
    }
    if group_path.is_empty() {
        normalized
    } else {
        group_path.to_owned()
    }
}

pub(crate) fn infer_workspace_kind(path: &str) -> &'static str {
    if path.contains("/Codex/") || path.contains("\\Codex\\") {
        "chat"
    } else if infer_worktree_id(path).is_some() {
        "worktree"
    } else {
        "workspace"
    }
}

pub(crate) fn infer_worktree_id(path: &str) -> Option<String> {
    let normalized = normalize_workspace_path(path);
    git_worktree_root_and_id(&normalized)
        .map(|(_, worktree_id)| worktree_id)
        .or_else(|| path_worktree_root_and_id(&normalized).map(|(_, worktree_id)| worktree_id))
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

fn git_worktree_root_and_id(path: &str) -> Option<(String, String)> {
    let mut current = PathBuf::from(path);
    loop {
        let git_marker = current.join(".git");
        if git_marker.is_file() {
            let git_dir = parse_gitdir_file(&git_marker, &current)?;
            let worktree_id = worktree_id_from_git_dir(&git_dir)?;
            return Some((current.to_string_lossy().into_owned(), worktree_id));
        }
        if git_marker.is_dir() {
            return None;
        }
        if !current.pop() {
            return None;
        }
    }
}

fn worktree_id_from_git_dir(git_dir: &Path) -> Option<String> {
    let mut components = git_dir.components().peekable();
    while let Some(component) = components.next() {
        if component.as_os_str().to_str()? != "worktrees" {
            continue;
        }
        return components
            .next()
            .and_then(|value| value.as_os_str().to_str())
            .map(str::to_owned)
            .filter(|value| !value.is_empty());
    }
    None
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

fn path_worktree_root_and_id(path: &str) -> Option<(String, String)> {
    let parts = Path::new(path).components().collect::<Vec<_>>();
    for index in 0..parts.len() {
        let component_text = parts[index].as_os_str().to_str()?;
        if component_text != "worktrees" && component_text != ".worktrees" {
            continue;
        }
        if index + 2 >= parts.len() {
            continue;
        }
        let worktree_id = parts[index + 1]
            .as_os_str()
            .to_str()
            .map(str::to_owned)
            .filter(|value| !value.is_empty())?;
        let mut root = PathBuf::new();
        for component in parts.iter().take(index + 3) {
            match component {
                Component::Prefix(prefix) => root.push(prefix.as_os_str()),
                Component::RootDir => root.push(component.as_os_str()),
                other => root.push(other.as_os_str()),
            }
        }
        return Some((root.to_string_lossy().into_owned(), worktree_id));
    }
    None
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
