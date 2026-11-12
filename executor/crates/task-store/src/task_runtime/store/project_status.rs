// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::TaskRuntimeError;

pub(super) fn default_board_config() -> Value {
    json!({
        "group_by": "status",
        "statuses": [
            {"id": "inbox", "name": "收集箱", "color": "gray"},
            {"id": "pending", "name": "待开始", "color": "blue"},
            {"id": "in_progress", "name": "进行中", "color": "orange"},
            {"id": "in_review", "name": "待确认", "color": "purple"},
            {"id": "completed", "name": "已完成", "color": "green"}
        ]
    })
}

pub(super) fn group_board_config(value: &Value) -> Result<Value, TaskRuntimeError> {
    let mut config = if value.is_null() {
        json!({})
    } else {
        value.clone()
    };
    if !config.is_object() {
        return Err(TaskRuntimeError::Invalid(
            "Invalid group board configuration".into(),
        ));
    }
    let defaults = default_board_config();
    config["statuses"] = defaults["statuses"].clone();
    config["processing_start_status_id"] = json!("pending");
    if config.get("group_by").is_none() {
        config["group_by"] = json!("status")
    }
    Ok(config)
}

fn status_ids(metadata: &Value) -> Vec<String> {
    let config = &metadata["board_config"];
    let defaults = default_board_config();
    config
        .get("statuses")
        .unwrap_or(&defaults["statuses"])
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|status| status["id"].as_str().map(str::to_owned))
        .collect()
}

pub(super) fn initial_status(metadata: &Value) -> Result<String, TaskRuntimeError> {
    status_ids(metadata)
        .into_iter()
        .next()
        .ok_or_else(|| TaskRuntimeError::Invalid("project board has no statuses".into()))
}

pub(super) fn validate(metadata: &Value, value: &str) -> Result<(), TaskRuntimeError> {
    status_ids(metadata)
        .iter()
        .any(|id| id == value)
        .then_some(())
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid task status".into()))
}

pub(super) fn robot_assignment_status<'a>(metadata: &Value, current: &'a str) -> &'a str {
    if current == "completed" {
        current
    } else {
        runtime_transition_status(metadata, current, "in_progress")
    }
}

pub(in crate::task_runtime) fn runtime_transition_status<'a>(
    metadata: &Value,
    current: &'a str,
    target: &'a str,
) -> &'a str {
    if validate(metadata, target).is_ok() {
        target
    } else {
        current
    }
}

pub(super) fn entered_processing(metadata: &Value, previous: &str, current: &str) -> bool {
    let ids = status_ids(metadata);
    // Match CloudProjectBoardConfig: an unset boundary uses the second status,
    // or the only status on a one-column board.
    let boundary = metadata["board_config"]["processing_start_status_id"]
        .as_str()
        .or_else(|| ids.get(1).or_else(|| ids.first()).map(String::as_str));
    let previous = ids.iter().position(|id| id == previous);
    let current = ids.iter().position(|id| id == current);
    let boundary = boundary.and_then(|boundary| ids.iter().position(|id| id == boundary));
    matches!((previous, current, boundary), (Some(previous), Some(current), Some(boundary))
        if previous < boundary && boundary <= current)
}
