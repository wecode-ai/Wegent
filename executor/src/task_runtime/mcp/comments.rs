// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{json, string_argument, TaskRuntime, Value};
use crate::task_runtime::{store::task_provider, TaskProviderKind, TaskRuntimeError};

#[cfg(test)]
mod tests;

pub(super) fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "space_id": {"type": "string"},
            "item_id": {"type": "string"},
            "body": {"type": "string", "minLength": 1},
            "mentions": {
                "type": "array", "maxItems": 64,
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["user", "agent"]},
                        "id": {"type": "string", "minLength": 1, "maxLength": 128},
                        "label": {"type": "string", "minLength": 1, "maxLength": 255}
                    },
                    "required": ["type", "id", "label"]
                }
            }
        },
        "required": ["space_id", "item_id", "body"]
    })
}

pub(super) async fn add_local(
    runtime: &TaskRuntime,
    arguments: &Value,
) -> Result<Value, TaskRuntimeError> {
    let project_id = string_argument(arguments, "space_id")?;
    let item_id = string_argument(arguments, "item_id")?;
    let body = string_argument(arguments, "body")?;
    if arguments
        .get("mentions")
        .is_some_and(|mentions| mentions != &json!([]))
    {
        return Err(TaskRuntimeError::Invalid(
            "Structured mentions require a shared Backend project".to_owned(),
        ));
    }
    runtime
        .add_comment(project_id, item_id, body)
        .await
        .and_then(|comment| serde_json::to_value(comment).map_err(super::invalid_json))
}

pub(super) async fn list(
    runtime: &TaskRuntime,
    arguments: &Value,
) -> Result<Value, TaskRuntimeError> {
    let project_id = string_argument(arguments, "space_id")?;
    let item_id = string_argument(arguments, "item_id")?;
    let project = runtime
        .list_projects()?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    if task_provider(&project)? != TaskProviderKind::Local {
        return Err(TaskRuntimeError::UnsupportedProvider(
            "Local activity comments require a local task provider".to_owned(),
        ));
    }
    runtime.get_task(project_id, item_id).await?;
    let after = arguments
        .get("after_sequence")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(200);
    if after < 0 || !(1..=500).contains(&limit) {
        return Err(TaskRuntimeError::Invalid(
            "Invalid comment cursor or limit".to_owned(),
        ));
    }
    let mut comments = runtime.list_comments(project_id, item_id, after)?;
    if after == 0 && comments.len() > limit as usize {
        comments.drain(..comments.len() - limit as usize);
    }
    Ok(json!(comments
        .into_iter()
        .take(limit as usize)
        .map(|comment| json!({
            "id": comment.message_id,
            "body": comment.content,
            "author": comment.sender_name,
            "web_url": null,
            "created_at": comment.created_at,
            "updated_at": comment.updated_at,
            "sequence_number": comment.sequence_number,
        }))
        .collect::<Vec<_>>()))
}
