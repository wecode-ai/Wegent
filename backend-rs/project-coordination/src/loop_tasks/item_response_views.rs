// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Metadata-derived loop-item views: tag/list normalization and the workflow/execution-config alias projections.

use super::*;

/// `normalize_tags`: trim, dedupe, and cap a metadata tag list.
pub(super) fn normalize_tags(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut tags: Vec<String> = Vec::new();
    for item in items {
        let tag = match item {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        let trimmed: String = tag.chars().take(32).collect();
        let trimmed = trimmed.trim().to_string();
        if !trimmed.is_empty() && !tags.contains(&trimmed) {
            tags.push(trimmed);
        }
        if tags.len() >= 20 {
            break;
        }
    }
    tags
}

/// A metadata value that is a JSON array, cloned; otherwise empty.
pub(super) fn json_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// A metadata value that is a JSON object, cloned; otherwise `None`.
pub(super) fn json_object(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(object @ Value::Object(_)) => Some(object.clone()),
        _ => None,
    }
}

/// `WorkflowExecutionConfig.workspace_binding`: the stored metadata object
/// re-serialized through `ProjectChatWorkspaceBinding`, whose `_to_camel`
/// alias generator renames the multi-word keys (`projectId`,
/// `deviceWorkspaceId`, `deviceId`, `runtimeProjectKey`) and whose field set
/// drops any extra stored keys (for example a stored `status`).
pub(super) fn workspace_binding_alias_view(binding: &Value) -> Value {
    let Some(map) = binding.as_object() else {
        return binding.clone();
    };
    let key = |name: &str, alias: &str| {
        map.get(name)
            .or_else(|| map.get(alias))
            .cloned()
            .unwrap_or(Value::Null)
    };
    serde_json::json!({
        "type": key("type", "type"),
        "projectId": key("project_id", "projectId"),
        "deviceWorkspaceId": key("device_workspace_id", "deviceWorkspaceId"),
        "deviceId": key("device_id", "deviceId"),
        "runtimeProjectKey": key("runtime_project_key", "runtimeProjectKey"),
    })
}

/// `execution_config`: the stored metadata object with the nested
/// `workspace_binding` re-serialized through its alias-generating schema.
pub(super) fn execution_config_view(value: Option<&Value>) -> Option<Value> {
    let config = json_object(value)?;
    let Some(map) = config.as_object() else {
        return Some(config);
    };
    let mut map = map.clone();
    if let Some(binding) = map.get("workspace_binding") {
        map.insert(
            "workspace_binding".to_string(),
            workspace_binding_alias_view(binding),
        );
    }
    Some(Value::Object(map))
}

/// `IssueWorkflowInstance`: the stored `metadata_json["workflow"]` object
/// re-serialized through its pydantic schema. Only the observable differences
/// from the stored shape are applied here: the nested `execution_config` uses
/// the camel-case `ProjectChatWorkspaceBinding` aliases, and each node carries
/// its defaulted `execution_error`. The stored object already holds every other
/// schema field, so the remaining keys pass through unchanged.
pub(super) fn workflow_view(workflow: &Value) -> Value {
    let Some(map) = workflow.as_object() else {
        return workflow.clone();
    };
    let mut map = map.clone();
    if let Some(config) = map.get("execution_config") {
        map.insert(
            "execution_config".to_string(),
            execution_config_view(Some(config)).unwrap_or_else(|| config.clone()),
        );
    }
    if let Some(Value::Array(nodes)) = map.get("nodes") {
        let nodes: Vec<Value> = nodes.iter().map(workflow_node_view).collect();
        map.insert("nodes".to_string(), Value::Array(nodes));
    }
    Value::Object(map)
}

/// `WorkflowNodeInstance`: the stored node re-serialized through its schema.
/// Applies the nested `execution_config` alias view and materializes the
/// defaulted `execution_error` when the stored node omits it.
pub(super) fn workflow_node_view(node: &Value) -> Value {
    let Some(map) = node.as_object() else {
        return node.clone();
    };
    let mut map = map.clone();
    if let Some(config) = map.get("execution_config") {
        map.insert(
            "execution_config".to_string(),
            execution_config_view(Some(config)).unwrap_or_else(|| config.clone()),
        );
    }
    map.entry("execution_error").or_insert(Value::Null);
    Value::Object(map)
}

pub(super) fn history_user_ids(metadata: &ItemMetadata) -> impl Iterator<Item = i32> + '_ {
    let assignments = metadata
        .assignment_history
        .as_ref()
        .and_then(Value::as_array);
    let statuses = metadata.status_history.as_ref().and_then(Value::as_array);
    assignments
        .into_iter()
        .flatten()
        .chain(statuses.into_iter().flatten())
        .filter_map(|row| row.get("by_user_id")?.as_i64()?.try_into().ok())
        .chain(
            assignments
                .into_iter()
                .flatten()
                .filter_map(history_target_user_id),
        )
        .filter(|id| *id > 0)
}

fn history_target_user_id(row: &Value) -> Option<i32> {
    if row.get("to_type")?.as_str()? != "user" {
        return None;
    }
    row.get("to_id")?.as_str()?.parse().ok()
}

pub(super) fn enrich_history_names(
    rows: &mut [Value],
    names: &std::collections::HashMap<i32, String>,
) {
    for row in rows {
        let Some(name) = row
            .get("by_user_id")
            .and_then(Value::as_i64)
            .and_then(|id| i32::try_from(id).ok())
            .and_then(|id| names.get(&id))
        else {
            continue;
        };
        row["by_user_name"] = json!(name);
        if row.get("to_type").and_then(Value::as_str) == Some("user")
            && row
                .get("to_name")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            && let Some(target_name) = history_target_user_id(row).and_then(|id| names.get(&id))
        {
            row["to_name"] = json!(target_name);
        }
    }
}
