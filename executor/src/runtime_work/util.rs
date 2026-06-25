// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    path::Path,
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
    request
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
