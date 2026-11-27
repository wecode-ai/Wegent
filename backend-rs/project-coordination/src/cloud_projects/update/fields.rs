// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `CloudProjectUpdate` nested schema decoding: each nested model's
//! `model_dump()` in declaration order, with the schema defaults filled in.
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

use super::request::{
    FIELD_AI_AUTOMATION, FIELD_BOARD_CONFIG, FIELD_CARD_DISPLAY, FIELD_EXECUTION_ENVIRONMENT,
    FIELD_PROVIDER_CONFIG, FIELD_PUBLIC_ACCESS, FIELD_PULL_REQUEST_AUTOMATION,
    FIELD_WORKFLOW_DEFINITION, bool_value, field_error, literal, model_object, model_object_at,
    required_string, string_value, value_error,
};

/// `PublicAccessGrant`: `{"role": "Viewer"}` by default.
pub(super) fn public_access_value(value: &Value) -> Result<Value, FastApiError> {
    let Value::Object(object) = value else {
        return Err(field_error(
            &[FIELD_PUBLIC_ACCESS],
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            value,
        ));
    };
    let role = match object.get("role") {
        None | Some(Value::Null) => "Viewer".to_owned(),
        Some(role) => literal("role", role, &["Developer", "Viewer"]).map_err(|_| {
            field_error(
                &[FIELD_PUBLIC_ACCESS, "role"],
                "literal_error",
                "Input should be 'Developer' or 'Viewer'",
                role,
            )
        })?,
    };
    let mut dump = Map::new();
    dump.insert("role".to_owned(), Value::String(role));
    Ok(Value::Object(dump))
}

pub(super) fn provider_config_value(value: &Value) -> Result<Map<String, Value>, FastApiError> {
    match value {
        Value::Object(object) => Ok(object.clone()),
        _ => Err(field_error(
            &[FIELD_PROVIDER_CONFIG],
            "dict_type",
            "Input should be a valid dictionary",
            value,
        )),
    }
}

/// `CloudProjectCardDisplay.model_dump()`: the four booleans in declaration
/// order, defaults `True`.
pub(super) fn card_display_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_CARD_DISPLAY, value)?;
    let mut dump = Map::new();
    for (key, default) in [
        ("show_assignee", true),
        ("show_priority", true),
        ("show_tags", true),
        ("show_date", true),
    ] {
        let flag = match object.get(key) {
            None | Some(Value::Null) => default,
            Some(value) => bool_value(&[FIELD_CARD_DISPLAY, key], value)?,
        };
        dump.insert(key.to_owned(), Value::Bool(flag));
    }
    Ok(Value::Object(dump))
}

/// `CloudProjectBoardConfig.model_dump()`, including the status defaults and
/// the `processing_start_status_id` derivation.
pub(super) fn board_config_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_BOARD_CONFIG, value)?;
    let group_by = match object.get("group_by") {
        None | Some(Value::Null) => "status".to_owned(),
        Some(value) => literal(
            "group_by",
            value,
            &["status", "priority", "assignee", "tag"],
        )
        .map_err(|_| {
            field_error(
                &[FIELD_BOARD_CONFIG, "group_by"],
                "literal_error",
                "Input should be 'status', 'priority', 'assignee' or 'tag'",
                value,
            )
        })?,
    };
    let statuses = match object.get("statuses") {
        None | Some(Value::Null) => default_board_statuses(),
        Some(value) => board_statuses(value)?,
    };
    let status_ids: Vec<String> = statuses
        .iter()
        .filter_map(|status| status.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    if statuses.len() != status_ids.len()
        || status_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != status_ids.len()
    {
        return Err(value_error("board status ids must be unique"));
    }
    if statuses.len() > 50 {
        return Err(value_error("board supports at most 50 statuses"));
    }
    let processing = match object.get("processing_start_status_id") {
        None | Some(Value::Null) => {
            if status_ids.is_empty() {
                None
            } else if status_ids.len() > 1 {
                Some(status_ids[1].clone())
            } else {
                Some(status_ids[0].clone())
            }
        }
        Some(value) => {
            let id = string_value("processing_start_status_id", value)?.to_owned();
            if !status_ids.contains(&id) {
                return Err(value_error(
                    "processing_start_status_id must reference a board status",
                ));
            }
            Some(id)
        }
    };
    let schedule_view = schedule_view_value(object.get("schedule_view"))?;

    let mut dump = Map::new();
    dump.insert("group_by".to_owned(), Value::String(group_by));
    dump.insert("statuses".to_owned(), Value::Array(statuses));
    dump.insert(
        "processing_start_status_id".to_owned(),
        processing.map_or(Value::Null, Value::String),
    );
    dump.insert("schedule_view".to_owned(), schedule_view);
    Ok(Value::Object(dump))
}

/// `default_board_statuses()`.
fn default_board_statuses() -> Vec<Value> {
    [
        ("inbox", "收集箱", "gray"),
        ("pending", "待开始", "blue"),
        ("in_progress", "进行中", "orange"),
        ("in_review", "待确认", "purple"),
        ("completed", "已完成", "green"),
    ]
    .into_iter()
    .map(|(id, name, color)| {
        let mut status = Map::new();
        status.insert("id".to_owned(), Value::String(id.to_owned()));
        status.insert("name".to_owned(), Value::String(name.to_owned()));
        status.insert("color".to_owned(), Value::String(color.to_owned()));
        Value::Object(status)
    })
    .collect()
}

fn board_statuses(value: &Value) -> Result<Vec<Value>, FastApiError> {
    let Value::Array(items) = value else {
        return Err(field_error(
            &[FIELD_BOARD_CONFIG, "statuses"],
            "list_type",
            "Input should be a valid list",
            value,
        ));
    };
    let mut statuses = Vec::with_capacity(items.len());
    for item in items {
        let object = model_object_at(&[FIELD_BOARD_CONFIG, "statuses"], item)?;
        let id = required_string(&[FIELD_BOARD_CONFIG, "statuses", "id"], object.get("id"))?;
        let name = required_string(
            &[FIELD_BOARD_CONFIG, "statuses", "name"],
            object.get("name"),
        )?;
        let color = match object.get("color") {
            None | Some(Value::Null) => "gray".to_owned(),
            Some(value) => literal(
                "color",
                value,
                &["gray", "blue", "orange", "purple", "green", "red"],
            )
            .map_err(|_| {
                field_error(
                    &[FIELD_BOARD_CONFIG, "statuses", "color"],
                    "literal_error",
                    "Input should be 'gray', 'blue', 'orange', 'purple', 'green' or 'red'",
                    value,
                )
            })?,
        };
        let mut status = Map::new();
        status.insert("id".to_owned(), Value::String(id));
        status.insert("name".to_owned(), Value::String(name));
        status.insert("color".to_owned(), Value::String(color));
        statuses.push(Value::Object(status));
    }
    Ok(statuses)
}

/// `CloudProjectScheduleViewConfig.model_dump()` with schema defaults.
fn schedule_view_value(value: Option<&Value>) -> Result<Value, FastApiError> {
    let object = match value {
        None | Some(Value::Null) => None,
        Some(Value::Object(object)) => Some(object),
        Some(other) => {
            return Err(field_error(
                &[FIELD_BOARD_CONFIG, "schedule_view"],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                other,
            ));
        }
    };
    let optional_text = |key: &str| -> Result<Value, FastApiError> {
        match object.and_then(|map| map.get(key)) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(value) => Ok(Value::String(string_value(key, value)?.to_owned())),
        }
    };
    let group_by = match object.and_then(|map| map.get("group_by")) {
        None | Some(Value::Null) => "none".to_owned(),
        Some(value) => literal(
            "group_by",
            value,
            &["none", "status", "priority", "assignee", "tag"],
        )
        .map_err(|_| {
            field_error(
                &[FIELD_BOARD_CONFIG, "schedule_view", "group_by"],
                "literal_error",
                "Input should be 'none', 'status', 'priority', 'assignee' or 'tag'",
                value,
            )
        })?,
    };
    let sort_by = match object.and_then(|map| map.get("sort_by")) {
        None | Some(Value::Null) => "start_asc".to_owned(),
        Some(value) => literal(
            "sort_by",
            value,
            &["start_asc", "due_asc", "updated_desc", "priority_desc"],
        )
        .map_err(|_| {
            field_error(
                &[FIELD_BOARD_CONFIG, "schedule_view", "sort_by"],
                "literal_error",
                "Input should be 'start_asc', 'due_asc', 'updated_desc' or 'priority_desc'",
                value,
            )
        })?,
    };
    let mut dump = Map::new();
    dump.insert("status_filter".to_owned(), optional_text("status_filter")?);
    dump.insert(
        "assignee_filter".to_owned(),
        optional_text("assignee_filter")?,
    );
    dump.insert("tag_filter".to_owned(), optional_text("tag_filter")?);
    dump.insert("group_by".to_owned(), Value::String(group_by));
    dump.insert("sort_by".to_owned(), Value::String(sort_by));
    Ok(Value::Object(dump))
}

/// `CloudProjectAiAutomation.model_dump()`.
pub(super) fn ai_automation_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_AI_AUTOMATION, value)?;
    let auto_retry = match object.get("auto_retry_on_failure") {
        None | Some(Value::Null) => false,
        Some(value) => bool_value(&[FIELD_AI_AUTOMATION, "auto_retry_on_failure"], value)?,
    };
    let max_retry = match object.get("max_retry_count") {
        None | Some(Value::Null) => 1,
        Some(value) => {
            let number = value
                .as_i64()
                .filter(|_| !value.is_boolean())
                .ok_or_else(|| {
                    field_error(
                        &[FIELD_AI_AUTOMATION, "max_retry_count"],
                        "int_parsing",
                        "Input should be a valid integer, unable to parse string as an integer",
                        value,
                    )
                })?;
            if !(1..=10).contains(&number) {
                return Err(field_error(
                    &[FIELD_AI_AUTOMATION, "max_retry_count"],
                    "less_than_equal",
                    "Input should be less than or equal to 10",
                    value,
                ));
            }
            number
        }
    };
    let mut dump = Map::new();
    dump.insert("auto_retry_on_failure".to_owned(), Value::Bool(auto_retry));
    dump.insert("max_retry_count".to_owned(), Value::from(max_retry));
    Ok(Value::Object(dump))
}

/// `CloudProjectPullRequestAutomation.model_dump()`.
pub(super) fn pull_request_automation_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_PULL_REQUEST_AUTOMATION, value)?;
    let enabled = match object.get("enabled") {
        None | Some(Value::Null) => false,
        Some(value) => bool_value(&[FIELD_PULL_REQUEST_AUTOMATION, "enabled"], value)?,
    };
    let statuses = match object.get("statuses") {
        None | Some(Value::Null) => default_pull_request_statuses(),
        Some(value) => {
            let Value::Array(items) = value else {
                return Err(field_error(
                    &[FIELD_PULL_REQUEST_AUTOMATION, "statuses"],
                    "list_type",
                    "Input should be a valid list",
                    value,
                ));
            };
            let allowed = [
                "checks_failed",
                "merge_conflict",
                "merge_queue_failed",
                "merge_queue_timed_out",
                "merge_queue_conflicting",
            ];
            let mut statuses: Vec<Value> = Vec::new();
            for item in items {
                let entry = literal("statuses", item, &allowed).map_err(|_| {
                    field_error(
                        &[FIELD_PULL_REQUEST_AUTOMATION, "statuses"],
                        "literal_error",
                        "Input should be one of the pull-request repair statuses",
                        item,
                    )
                })?;
                // `validate_statuses` keeps the first occurrence of each value.
                if !statuses
                    .iter()
                    .any(|held| held.as_str() == Some(entry.as_str()))
                {
                    statuses.push(Value::String(entry));
                }
            }
            statuses
        }
    };
    let prompt = match object.get("prompt") {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_value("prompt", value)?.to_owned(),
    };
    let mut dump = Map::new();
    dump.insert("enabled".to_owned(), Value::Bool(enabled));
    dump.insert("statuses".to_owned(), Value::Array(statuses));
    dump.insert("prompt".to_owned(), Value::String(prompt));
    Ok(Value::Object(dump))
}

fn default_pull_request_statuses() -> Vec<Value> {
    [
        "checks_failed",
        "merge_conflict",
        "merge_queue_failed",
        "merge_queue_timed_out",
        "merge_queue_conflicting",
    ]
    .into_iter()
    .map(|status| Value::String(status.to_owned()))
    .collect()
}

/// `ProjectWorkflowDefinition.model_dump()` with schema defaults. Unknown
/// keys are ignored; the declared keys are emitted in declaration order.
pub(super) fn workflow_definition_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_WORKFLOW_DEFINITION, value)?;
    let version = match object.get("version") {
        None | Some(Value::Null) => 1,
        Some(value) => value
            .as_i64()
            .filter(|_| !value.is_boolean())
            .ok_or_else(|| {
                field_error(
                    &[FIELD_WORKFLOW_DEFINITION, "version"],
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    value,
                )
            })?,
    };
    if version < 1 {
        return Err(field_error(
            &[FIELD_WORKFLOW_DEFINITION, "version"],
            "greater_than_equal",
            "Input should be greater than or equal to 1",
            &Value::from(version),
        ));
    }
    let nodes = object
        .get("nodes")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    if let Value::Array(items) = &nodes {
        bounded_list(&[FIELD_WORKFLOW_DEFINITION, "nodes"], items.len(), 50)?;
        let node_ids: Vec<&str> = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect();
        if node_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != node_ids.len()
        {
            return Err(value_error("workflow node ids must be unique"));
        }
    }
    // `infer_legacy_stage_mode`: a definition without `stage_mode` but with
    // nodes infers `dag`.
    let stage_mode = match object.get("stage_mode") {
        None | Some(Value::Null) if !nodes.as_array().is_some_and(Vec::is_empty) => {
            "dag".to_owned()
        }
        None | Some(Value::Null) => "none".to_owned(),
        Some(value) => literal("stage_mode", value, &["none", "dag"]).map_err(|_| {
            field_error(
                &[FIELD_WORKFLOW_DEFINITION, "stage_mode"],
                "literal_error",
                "Input should be 'none' or 'dag'",
                value,
            )
        })?,
    };
    let advancement_policy = match object.get("advancement_policy") {
        None | Some(Value::Null) => "manual".to_owned(),
        Some(value) => literal("advancement_policy", value, &["manual", "ai"]).map_err(|_| {
            field_error(
                &[FIELD_WORKFLOW_DEFINITION, "advancement_policy"],
                "literal_error",
                "Input should be 'manual' or 'ai'",
                value,
            )
        })?,
    };
    let coordinator_prompt = match object.get("coordinator_prompt") {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_value("coordinator_prompt", value)?.to_owned(),
    };
    let approval_policy = match object.get("approval_policy") {
        None | Some(Value::Null) => "required".to_owned(),
        Some(value) => {
            literal("approval_policy", value, &["required", "automatic"]).map_err(|_| {
                field_error(
                    &[FIELD_WORKFLOW_DEFINITION, "approval_policy"],
                    "literal_error",
                    "Input should be 'required' or 'automatic'",
                    value,
                )
            })?
        }
    };
    let ai_automation_rule_id = match object.get("ai_automation_rule_id") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => Value::String(string_value("ai_automation_rule_id", value)?.to_owned()),
    };
    if advancement_policy == "ai" && ai_automation_rule_id.is_null() {
        return Err(value_error("AI advancement requires an AI automation rule"));
    }
    let execution_config = match object.get("execution_config") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => value.clone(),
    };

    let mut dump = Map::new();
    dump.insert("version".to_owned(), Value::from(version));
    dump.insert("stage_mode".to_owned(), Value::String(stage_mode));
    dump.insert(
        "advancement_policy".to_owned(),
        Value::String(advancement_policy),
    );
    dump.insert(
        "coordinator_prompt".to_owned(),
        Value::String(coordinator_prompt),
    );
    dump.insert("approval_policy".to_owned(), Value::String(approval_policy));
    dump.insert("ai_automation_rule_id".to_owned(), ai_automation_rule_id);
    dump.insert("execution_config".to_owned(), execution_config);
    dump.insert("nodes".to_owned(), nodes);
    Ok(Value::Object(dump))
}

/// `ExecutionEnvironmentDefinition.model_dump()` with schema defaults.
pub(super) fn execution_environment_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object(FIELD_EXECUTION_ENVIRONMENT, value)?;
    let workspace_policy = match object.get("workspace_policy") {
        None | Some(Value::Null) => "git_worktree".to_owned(),
        Some(value) => {
            literal("workspace_policy", value, &["git_worktree", "project"]).map_err(|_| {
                field_error(
                    &[FIELD_EXECUTION_ENVIRONMENT, "workspace_policy"],
                    "literal_error",
                    "Input should be 'git_worktree' or 'project'",
                    value,
                )
            })?
        }
    };
    let repositories = match object.get("repositories") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut repositories = Vec::with_capacity(items.len());
            for item in items {
                repositories.push(repository_value(item)?);
            }
            repositories
        }
        Some(value) => {
            return Err(field_error(
                &[FIELD_EXECUTION_ENVIRONMENT, "repositories"],
                "list_type",
                "Input should be a valid list",
                value,
            ));
        }
    };
    let setup_steps = match object.get("setup_steps") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut steps = Vec::with_capacity(items.len());
            for item in items {
                steps.push(setup_step_value(item)?);
            }
            steps
        }
        Some(value) => {
            return Err(field_error(
                &[FIELD_EXECUTION_ENVIRONMENT, "setup_steps"],
                "list_type",
                "Input should be a valid list",
                value,
            ));
        }
    };
    let primary_count = repositories
        .iter()
        .filter(|repository| repository.get("primary").and_then(Value::as_bool) == Some(true))
        .count();
    bounded_list(
        &[FIELD_EXECUTION_ENVIRONMENT, "repositories"],
        repositories.len(),
        20,
    )?;
    bounded_list(
        &[FIELD_EXECUTION_ENVIRONMENT, "setup_steps"],
        setup_steps.len(),
        50,
    )?;
    if !repositories.is_empty() && primary_count != 1 {
        return Err(value_error(
            "execution environment must have exactly one primary repository",
        ));
    }
    validate_repository_geometry(&repositories, &setup_steps)?;

    let mut dump = Map::new();
    dump.insert(
        "workspace_policy".to_owned(),
        Value::String(workspace_policy),
    );
    dump.insert("repositories".to_owned(), Value::Array(repositories));
    dump.insert("setup_steps".to_owned(), Value::Array(setup_steps));
    Ok(Value::Object(dump))
}

fn repository_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object_at(&[FIELD_EXECUTION_ENVIRONMENT, "repositories"], value)?;
    let name = required_string(
        &[FIELD_EXECUTION_ENVIRONMENT, "repositories", "name"],
        object.get("name"),
    )?;
    let url = required_string(
        &[FIELD_EXECUTION_ENVIRONMENT, "repositories", "url"],
        object.get("url"),
    )?;
    let reference = match object.get("ref") {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_value("ref", value)?.trim().to_owned(),
    };
    let path = required_string(
        &[FIELD_EXECUTION_ENVIRONMENT, "repositories", "path"],
        object.get("path"),
    )?;
    let primary = match object.get("primary") {
        None | Some(Value::Null) => false,
        Some(value) => bool_value(&[FIELD_EXECUTION_ENVIRONMENT, "primary"], value)?,
    };
    let mut dump = Map::new();
    dump.insert("name".to_owned(), Value::String(name.trim().to_owned()));
    dump.insert("url".to_owned(), Value::String(url.trim().to_owned()));
    dump.insert("ref".to_owned(), Value::String(reference));
    dump.insert(
        "path".to_owned(),
        Value::String(relative_path(
            &path,
            "repository path must be a normalized relative path",
        )?),
    );
    dump.insert("primary".to_owned(), Value::Bool(primary));
    Ok(Value::Object(dump))
}

/// `require_relative_path` / `require_relative_working_directory`: the
/// submitted path must not be absolute and must not contain empty, `.` or
/// `..` segments. Backslashes are normalised to `/` first.
fn relative_path(path: &str, message: &str) -> Result<String, FastApiError> {
    let text = path.trim();
    if text.starts_with('/') || text.starts_with('\\') {
        return Err(value_error(message));
    }
    let normalized = text.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.iter().any(|part| matches!(*part, "" | "." | "..")) {
        return Err(value_error(message));
    }
    Ok(parts.join("/"))
}

fn setup_step_value(value: &Value) -> Result<Value, FastApiError> {
    let object = model_object_at(&[FIELD_EXECUTION_ENVIRONMENT, "setup_steps"], value)?;
    let command = required_string(
        &[FIELD_EXECUTION_ENVIRONMENT, "setup_steps", "command"],
        object.get("command"),
    )?;
    let working_directory = match object.get("working_directory") {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_value("working_directory", value)?.trim().to_owned(),
    };
    let working_directory = if working_directory.is_empty() {
        String::new()
    } else {
        relative_path(
            &working_directory,
            "working directory must be a normalized relative path",
        )?
    };
    let mut dump = Map::new();
    dump.insert(
        "command".to_owned(),
        Value::String(command.trim().to_owned()),
    );
    dump.insert(
        "working_directory".to_owned(),
        Value::String(working_directory),
    );
    Ok(Value::Object(dump))
}

/// `ExecutionEnvironmentDefinition.validate_repositories`: unique names and
/// paths, non-overlapping paths, and setup working directories inside a
/// configured repository.
fn validate_repository_geometry(
    repositories: &[Value],
    setup_steps: &[Value],
) -> Result<(), FastApiError> {
    let text = |value: &Value, key: &str| -> String {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let names: Vec<String> = repositories.iter().map(|r| text(r, "name")).collect();
    let paths: Vec<String> = repositories.iter().map(|r| text(r, "path")).collect();
    if names
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != names.len()
    {
        return Err(value_error("repository names must be unique"));
    }
    if paths
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != paths.len()
    {
        return Err(value_error("repository paths must be unique"));
    }
    for (index, left) in paths.iter().enumerate() {
        for right in &paths[index + 1..] {
            if left != right
                && (left.starts_with(&format!("{right}/"))
                    || right.starts_with(&format!("{left}/")))
            {
                return Err(value_error("repository paths must not overlap"));
            }
        }
    }
    if !paths.is_empty() {
        for step in setup_steps {
            let working_directory = text(step, "working_directory");
            if working_directory.is_empty() {
                continue;
            }
            let inside = paths.iter().any(|path| {
                working_directory == *path || working_directory.starts_with(&format!("{path}/"))
            });
            if !inside {
                return Err(value_error(
                    "setup working directory must be inside a configured repository",
                ));
            }
        }
    }
    Ok(())
}

/// A pydantic `max_length` list bound.
fn bounded_list(loc: &[&str], len: usize, max: usize) -> Result<(), FastApiError> {
    if len > max {
        return Err(field_error(
            loc,
            "too_long",
            &format!("List should have at most {max} items after validation, not {len}"),
            &Value::from(len),
        ));
    }
    Ok(())
}
