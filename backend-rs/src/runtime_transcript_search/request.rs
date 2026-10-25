use brz_http_server::StatusCode;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

#[derive(Debug)]
pub(super) struct SearchRequest {
    pub device_id: String,
    pub task_id: String,
    pub project_session: Option<(String, String)>,
    query: String,
    limit: Option<u64>,
    workspace_path: Option<String>,
    runtime_handle: Option<Map<String, Value>>,
}

impl SearchRequest {
    pub fn validated(body: &Value) -> Result<Self, FastApiError> {
        let mut errors = Vec::new();
        if !body.is_object() {
            return Err(FastApiError::json_body(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "error_code": 422, "detail": "Request parameter validation failed",
                    "errors": [{"type": "model_attributes_type", "loc": ["body"],
                        "msg": "Input should be a valid dictionary or object to extract fields from", "input": body}],
                }),
            ));
        }
        let device_id = string(
            body,
            &["deviceId", "device_id"],
            true,
            true,
            &[],
            &mut errors,
        );
        let task_id = string(
            body,
            &["taskId", "localTaskId", "local_task_id"],
            true,
            true,
            &[],
            &mut errors,
        );
        let query = string(body, &["query"], true, true, &[], &mut errors);
        let workspace_path = string(
            body,
            &["workspacePath", "workspace_path"],
            false,
            false,
            &[],
            &mut errors,
        );
        let runtime_handle = object(body, &["runtimeHandle", "runtime_handle"], &mut errors);
        let project_session = scope(body, &mut errors);
        let limit = limit(body, &mut errors);
        if !errors.is_empty() {
            return Err(FastApiError::json_body(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "error_code": 422, "detail": "Request parameter validation failed", "errors": errors,
                }),
            ));
        }
        Ok(Self {
            device_id: device_id.unwrap(),
            task_id: task_id.unwrap(),
            query: query.unwrap(),
            workspace_path,
            runtime_handle,
            project_session,
            limit,
        })
    }

    /// Project scope never delegates client-supplied paths or runtime handles.
    pub fn payload(&self, task_id: &str, project_bound: bool) -> Value {
        let mut payload =
            json!({ "deviceId": self.device_id, "taskId": task_id.trim(), "query": self.query });
        if let Some(limit) = self.limit {
            payload["limit"] = json!(limit);
        }
        if !project_bound {
            if let Some(path) = self
                .workspace_path
                .as_deref()
                .filter(|path| !path.is_empty())
            {
                let normalized = path.trim().trim_end_matches('/');
                payload["workspacePath"] = json!(if normalized.is_empty() {
                    "/"
                } else {
                    normalized
                });
            }
            if let Some(team_id) = self
                .runtime_handle
                .as_ref()
                .and_then(|handle| handle.get("wegentTeam"))
                .and_then(|team| team.get("id"))
                .filter(|id| id.as_i64().is_some_and(|id| id > 0) || **id == Value::Bool(true))
            {
                payload["runtimeHandle"] = json!({"wegentTeam": {"id": team_id}});
            }
        }
        payload
    }
}

fn value<'a>(body: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| body.get(name))
}

fn invalid(
    errors: &mut Vec<Value>,
    field: &str,
    prefix: &[&str],
    kind: &str,
    msg: &str,
    input: Value,
) {
    let loc: Vec<&str> = std::iter::once("body")
        .chain(prefix.iter().copied())
        .chain(std::iter::once(field))
        .collect();
    let mut error = json!({"type": kind, "loc": loc, "msg": msg, "input": input,
        "url": format!("https://errors.pydantic.dev/2.12/v/{kind}")});
    if kind == "string_too_short" {
        error["ctx"] = json!({"min_length": 1});
    }
    errors.push(error);
}

fn string(
    body: &Value,
    names: &[&str],
    required: bool,
    nonempty: bool,
    prefix: &[&str],
    errors: &mut Vec<Value>,
) -> Option<String> {
    match value(body, names) {
        Some(Value::String(text)) if !nonempty || !text.is_empty() => Some(text.clone()),
        Some(Value::String(text)) => {
            invalid(
                errors,
                names[0],
                prefix,
                "string_too_short",
                "String should have at least 1 character",
                json!(text),
            );
            None
        }
        None if required => {
            invalid(
                errors,
                names[0],
                prefix,
                "missing",
                "Field required",
                body.clone(),
            );
            None
        }
        None | Some(Value::Null) if !required => None,
        Some(input) => {
            invalid(
                errors,
                names[0],
                prefix,
                "string_type",
                "Input should be a valid string",
                input.clone(),
            );
            None
        }
        None => None,
    }
}

fn object(body: &Value, names: &[&str], errors: &mut Vec<Value>) -> Option<Map<String, Value>> {
    match value(body, names) {
        Some(Value::Object(map)) => Some(map.clone()),
        None | Some(Value::Null) => None,
        Some(input) => {
            invalid(
                errors,
                names[0],
                &[],
                "dict_type",
                "Input should be a valid dictionary",
                input.clone(),
            );
            None
        }
    }
}

fn scope(body: &Value, errors: &mut Vec<Value>) -> Option<(String, String)> {
    let scope = value(body, &["projectSession", "project_session"])?;
    if scope.is_null() {
        return None;
    }
    if !scope.is_object() {
        invalid(
            errors,
            "projectSession",
            &[],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectSessionScope",
            scope.clone(),
        );
        return None;
    }
    let project = string(
        scope,
        &["projectId", "project_id"],
        true,
        true,
        &["projectSession"],
        errors,
    );
    let issue = string(
        scope,
        &["issueId", "issue_id"],
        true,
        true,
        &["projectSession"],
        errors,
    );
    project.zip(issue)
}

fn integer(input: &Value) -> Option<i64> {
    match input {
        Value::Bool(value) => Some(i64::from(*value)),
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|n| {
                    n.is_finite()
                        && n.fract() == 0.0
                        && *n >= i64::MIN as f64
                        && *n < i64::MAX as f64
                })
                .map(|n| n as i64)
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn limit(body: &Value, errors: &mut Vec<Value>) -> Option<u64> {
    let input = body.get("limit").filter(|input| !input.is_null())?;
    match integer(input) {
        Some(limit) if (1..=250).contains(&limit) => Some(limit as u64),
        Some(limit) => {
            let (kind, msg, ctx) = if limit < 1 {
                (
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    json!({"ge":1}),
                )
            } else {
                (
                    "less_than_equal",
                    "Input should be less than or equal to 250",
                    json!({"le":250}),
                )
            };
            invalid(errors, "limit", &[], kind, msg, input.clone());
            errors.last_mut().unwrap()["ctx"] = ctx;
            None
        }
        None => {
            invalid(
                errors,
                "limit",
                &[],
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                input.clone(),
            );
            None
        }
    }
}
