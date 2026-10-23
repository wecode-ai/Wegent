// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `RuntimeTranscriptRequest` pydantic-compatible validation, address
//! normalization and the executor payload for
//! `POST /api/runtime-work/transcript`.
//!
//! Mirrors `app.schemas.runtime_work.RuntimeTranscriptRequest` (pydantic 2.12),
//! `runtime_work_service._normalized_address`,
//! `_runtime_address_team_id` and `_runtime_transcript_payload`.

use brz_http_server::StatusCode;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::runtime_work_projection::normalize_workspace_path;

/// `VALIDATION_FAILED` (the application's `validation_exception_handler`).
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// `_normalized_address`: trim the task id, normalize the workspace path, and
/// expose only the resolved `wegentTeam` id from the private runtime handle.
pub(crate) struct NormalizedAddress {
    pub(crate) device_id: String,
    pub(crate) workspace_path: Option<String>,
    pub(crate) task_id: String,
    pub(crate) runtime_handle: Option<Value>,
}

pub(crate) fn normalized_address(request: &TranscriptRequest) -> NormalizedAddress {
    let workspace_path = request
        .workspace_path
        .as_deref()
        .filter(|path| !path.is_empty())
        .and_then(normalize_workspace_path);
    let runtime_handle = runtime_address_team_id(request.runtime_handle.as_ref())
        .map(|team_id| json!({"wegentTeam": {"id": team_id}}));
    NormalizedAddress {
        device_id: request.device_id.clone(),
        workspace_path,
        task_id: request.local_task_id.trim().to_string(),
        runtime_handle,
    }
}

/// `_runtime_address_team_id`: the positive integer `wegentTeam.id` binding.
pub(crate) fn runtime_address_team_id(handle: Option<&Value>) -> Option<i64> {
    handle?
        .get("wegentTeam")?
        .get("id")?
        .as_i64()
        .filter(|team_id| *team_id > 0)
}

/// `_runtime_transcript_payload`: the address fields followed by the paging
/// flags the caller supplied.
pub(crate) fn transcript_payload(
    request: &TranscriptRequest,
    address: &NormalizedAddress,
) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "deviceId".to_string(),
        Value::String(address.device_id.clone()),
    );
    if let Some(workspace_path) = address.workspace_path.as_ref() {
        payload.insert(
            "workspacePath".to_string(),
            Value::String(workspace_path.clone()),
        );
    }
    payload.insert("taskId".to_string(), Value::String(address.task_id.clone()));
    if let Some(runtime_handle) = address.runtime_handle.as_ref() {
        payload.insert("runtimeHandle".to_string(), runtime_handle.clone());
    }
    if let Some(limit) = request.limit {
        payload.insert("limit".to_string(), Value::from(limit));
    }
    if let Some(cursor) = request
        .before_cursor
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        payload.insert(
            "beforeCursor".to_string(),
            Value::String(cursor.to_string()),
        );
    }
    if let Some(cursor) = request
        .after_cursor
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        payload.insert("afterCursor".to_string(), Value::String(cursor.to_string()));
    }
    if request.include_full_content {
        payload.insert("includeFullContent".to_string(), Value::Bool(true));
    }
    if request.conversation_context_only {
        payload.insert("conversationContextOnly".to_string(), Value::Bool(true));
    }
    Value::Object(payload)
}

/// `RuntimeTranscriptRequest` after pydantic validation.
pub(crate) struct TranscriptRequest {
    pub(crate) device_id: String,
    pub(crate) workspace_path: Option<String>,
    pub(crate) local_task_id: String,
    pub(crate) runtime_handle: Option<Value>,
    pub(crate) limit: Option<i64>,
    pub(crate) project_session: Option<ProjectSessionRequest>,
    pub(crate) before_cursor: Option<String>,
    pub(crate) after_cursor: Option<String>,
    pub(crate) include_full_content: bool,
    pub(crate) conversation_context_only: bool,
}

/// `ProjectSessionScope`.
pub(crate) struct ProjectSessionRequest {
    pub(crate) project_id: String,
    pub(crate) issue_id: String,
}

impl TranscriptRequest {
    /// Decode and validate the request body; any failure renders the
    /// application's 422 body.
    pub(crate) fn validated(body: &Value) -> Result<Self, FastApiError> {
        Self::decode(body).map_err(validation_error)
    }

    fn decode(body: &Value) -> Result<Self, Vec<Value>> {
        let Value::Object(object) = body else {
            return Err(vec![pydantic_error(
                "model_attributes_type",
                &["body"],
                "Input should be a valid dictionary or object to extract fields from",
                body,
                None,
            )]);
        };
        let mut errors = Vec::new();
        let device_id =
            required_nonempty(object, "deviceId", &["deviceId", "device_id"], &mut errors);
        let workspace_path = optional_string_field(
            object,
            "workspacePath",
            &["workspacePath", "workspace_path"],
            &mut errors,
        );
        let local_task_id = required_nonempty(
            object,
            "taskId",
            &["taskId", "localTaskId", "local_task_id"],
            &mut errors,
        );
        let runtime_handle = optional_object_field(
            object,
            "runtimeHandle",
            &["runtimeHandle", "runtime_handle"],
            &mut errors,
        );
        let limit = optional_bounded_int(object, "limit", 1, 200, &mut errors);
        let project_session = optional_project_session(object, &mut errors);
        let before_cursor = optional_string_field(
            object,
            "beforeCursor",
            &["beforeCursor", "before_cursor"],
            &mut errors,
        );
        let after_cursor = optional_string_field(
            object,
            "afterCursor",
            &["afterCursor", "after_cursor"],
            &mut errors,
        );
        let include_full_content = bool_field(
            object,
            "includeFullContent",
            &["includeFullContent", "include_full_content"],
            &mut errors,
        );
        let conversation_context_only = bool_field(
            object,
            "conversationContextOnly",
            &["conversationContextOnly", "conversation_context_only"],
            &mut errors,
        );
        match (
            device_id,
            local_task_id,
            project_session,
            include_full_content,
            conversation_context_only,
        ) {
            (
                Some(device_id),
                Some(local_task_id),
                Some(project_session),
                Some(include),
                Some(only),
            ) if errors.is_empty() => Ok(Self {
                device_id,
                workspace_path: workspace_path.flatten(),
                local_task_id,
                runtime_handle: runtime_handle.flatten(),
                limit: limit.flatten(),
                project_session,
                before_cursor: before_cursor.flatten(),
                after_cursor: after_cursor.flatten(),
                include_full_content: include,
                conversation_context_only: only,
            }),
            _ => Err(errors),
        }
    }
}

/// Look up an alias list then the snake_case field name.
fn field<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| object.get(*name))
}

fn required_nonempty(
    object: &Map<String, Value>,
    alias: &str,
    names: &[&str],
    errors: &mut Vec<Value>,
) -> Option<String> {
    let Some(value) = field(object, names) else {
        errors.push(pydantic_error(
            "missing",
            &["body", alias],
            "Field required",
            &Value::Object(object.clone()),
            None,
        ));
        return None;
    };
    match value {
        Value::String(text) if text.is_empty() => {
            errors.push(pydantic_error(
                "string_too_short",
                &["body", alias],
                "String should have at least 1 character",
                value,
                Some(json!({"min_length": 1})),
            ));
            None
        }
        Value::String(text) => Some(text.clone()),
        other => {
            errors.push(pydantic_error(
                "string_type",
                &["body", alias],
                "Input should be a valid string",
                other,
                None,
            ));
            None
        }
    }
}

fn optional_string_field(
    object: &Map<String, Value>,
    alias: &str,
    names: &[&str],
    errors: &mut Vec<Value>,
) -> Option<Option<String>> {
    match field(object, names) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(other) => {
            errors.push(pydantic_error(
                "string_type",
                &["body", alias],
                "Input should be a valid string",
                other,
                None,
            ));
            None
        }
    }
}

fn optional_object_field(
    object: &Map<String, Value>,
    alias: &str,
    names: &[&str],
    errors: &mut Vec<Value>,
) -> Option<Option<Value>> {
    match field(object, names) {
        None | Some(Value::Null) => Some(None),
        Some(value @ Value::Object(_)) => Some(Some(value.clone())),
        Some(other) => {
            errors.push(pydantic_error(
                "dict_type",
                &["body", alias],
                "Input should be a valid dictionary",
                other,
                None,
            ));
            None
        }
    }
}

fn optional_bounded_int(
    object: &Map<String, Value>,
    field_name: &str,
    minimum: i64,
    maximum: i64,
    errors: &mut Vec<Value>,
) -> Option<Option<i64>> {
    match object.get(field_name) {
        None | Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => {
            let Some(value) = number.as_i64() else {
                errors.push(pydantic_error(
                    "int_type",
                    &["body", field_name],
                    "Input should be a valid integer",
                    &Value::Number(number.clone()),
                    None,
                ));
                return None;
            };
            if value < minimum {
                errors.push(pydantic_error(
                    "greater_than_equal",
                    &["body", field_name],
                    &format!("Input should be greater than or equal to {minimum}"),
                    &Value::Number(number.clone()),
                    Some(json!({"ge": minimum})),
                ));
                return None;
            }
            if value > maximum {
                errors.push(pydantic_error(
                    "less_than_equal",
                    &["body", field_name],
                    &format!("Input should be less than or equal to {maximum}"),
                    &Value::Number(number.clone()),
                    Some(json!({"le": maximum})),
                ));
                return None;
            }
            Some(Some(value))
        }
        Some(other) => {
            errors.push(pydantic_error(
                "int_type",
                &["body", field_name],
                "Input should be a valid integer",
                other,
                None,
            ));
            None
        }
    }
}

fn optional_project_session(
    object: &Map<String, Value>,
    errors: &mut Vec<Value>,
) -> Option<Option<ProjectSessionRequest>> {
    let Some(value) = object.get("projectSession") else {
        return Some(None);
    };
    if value.is_null() {
        return Some(None);
    }
    let Some(scope) = value.as_object() else {
        errors.push(pydantic_error(
            "dict_type",
            &["body", "projectSession"],
            "Input should be a valid dictionary",
            value,
            None,
        ));
        return None;
    };
    let project_id = required_nonempty(scope, "projectId", &["projectId", "project_id"], errors);
    let issue_id = required_nonempty(scope, "issueId", &["issueId", "issue_id"], errors);
    Some(match (project_id, issue_id) {
        (Some(project_id), Some(issue_id)) => Some(ProjectSessionRequest {
            project_id,
            issue_id,
        }),
        _ => None,
    })
}

fn bool_field(
    object: &Map<String, Value>,
    alias: &str,
    names: &[&str],
    errors: &mut Vec<Value>,
) -> Option<bool> {
    match field(object, names) {
        None => Some(false),
        Some(Value::Bool(value)) => Some(*value),
        Some(other) => {
            errors.push(pydantic_error(
                "bool_type",
                &["body", alias],
                "Input should be a valid boolean",
                other,
                None,
            ));
            None
        }
    }
}

/// One pydantic `ValidationError.errors()` entry.
fn pydantic_error(
    kind: &str,
    location: &[&str],
    message: &str,
    input: &Value,
    ctx: Option<Value>,
) -> Value {
    let mut entry = json!({
        "type": kind,
        "loc": location,
        "msg": message,
        "input": input,
        "url": format!("https://errors.pydantic.dev/2.12/v/{kind}"),
    });
    if let Some(ctx) = ctx {
        entry["ctx"] = ctx;
    }
    entry
}

/// The application's `validation_exception_handler` 422 body.
fn validation_error(errors: Vec<Value>) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "error_code": 422,
            "detail": VALIDATION_FAILED,
            "errors": errors,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Value {
        json!({
            "deviceId": "device-1",
            "taskId": "runtime-1",
            "limit": 20,
            "projectSession": {"projectId": "42", "issueId": "ISSUE-1"},
        })
    }

    #[test]
    fn request_validation_accepts_the_recorded_shape() {
        let request = TranscriptRequest::validated(&body()).expect("valid request");
        assert_eq!(request.device_id, "device-1");
        assert_eq!(request.local_task_id, "runtime-1");
        assert_eq!(request.limit, Some(20));
        let scope = request.project_session.expect("scope");
        assert_eq!(scope.project_id, "42");
        assert_eq!(scope.issue_id, "ISSUE-1");
    }

    #[test]
    fn request_validation_accepts_snake_case_and_task_alias() {
        let request = TranscriptRequest::validated(&json!({
            "device_id": "device-1",
            "localTaskId": "runtime-1",
        }))
        .expect("valid request");
        assert_eq!(request.local_task_id, "runtime-1");
        assert!(request.project_session.is_none());
    }

    #[test]
    fn request_validation_rejects_missing_and_out_of_range_values() {
        assert!(TranscriptRequest::validated(&json!({"taskId": "runtime-1"})).is_err());
        assert!(TranscriptRequest::validated(&json!({"deviceId": "", "taskId": "t"})).is_err());
        assert!(
            TranscriptRequest::validated(&json!({"deviceId": "d", "taskId": "t", "limit": 0}))
                .is_err()
        );
        assert!(
            TranscriptRequest::validated(&json!({"deviceId": "d", "taskId": "t", "limit": 201}))
                .is_err()
        );
        assert!(
            TranscriptRequest::validated(
                &json!({"deviceId": "d", "taskId": "t", "projectSession": {"projectId": ""}})
            )
            .is_err()
        );
    }

    #[test]
    fn payload_omits_false_and_empty_flags() {
        let request = TranscriptRequest::validated(&body()).expect("valid request");
        let payload = transcript_payload(&request, &normalized_address(&request));
        assert_eq!(
            payload,
            json!({"deviceId": "device-1", "taskId": "runtime-1", "limit": 20})
        );
    }

    #[test]
    fn payload_includes_paging_flags_and_the_safe_runtime_handle() {
        let request = TranscriptRequest::validated(&json!({
            "deviceId": "device-1",
            "taskId": " runtime-1 ",
            "workspacePath": "/work/project/",
            "runtimeHandle": {
                "modelSelection": {"modelName": "gpt"},
                "wegentTeam": {"id": 7},
            },
            "beforeCursor": "offset:3",
            "afterCursor": "",
            "includeFullContent": true,
            "conversationContextOnly": true,
        }))
        .expect("valid request");
        let payload = transcript_payload(&request, &normalized_address(&request));
        assert_eq!(
            payload,
            json!({
                "deviceId": "device-1",
                "workspacePath": "/work/project",
                "taskId": "runtime-1",
                "runtimeHandle": {"wegentTeam": {"id": 7}},
                "beforeCursor": "offset:3",
                "includeFullContent": true,
                "conversationContextOnly": true,
            })
        );
    }
}
