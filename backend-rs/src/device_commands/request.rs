// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DeviceCommandRequest` pydantic-compatible validation for
//! `POST /api/devices/{device_id}/commands`.
//!
//! Mirrors `app.schemas.device.DeviceCommandRequest` (pydantic 2.12) and the
//! application's `validation_exception_handler` body.

use brz_http_server::StatusCode;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

use super::{
    DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_MAX_OUTPUT_BYTES, MAX_COMMAND_TIMEOUT_SECONDS,
    MAX_OUTPUT_BYTES,
};

/// `validation_exception_handler`'s fixed detail.
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// `DeviceCommandRequest` after pydantic validation.
///
/// `env` keeps the request's member order so the published payload matches the
/// source `dict` iteration order.
#[derive(Debug)]
pub(crate) struct DeviceCommandRequest {
    pub(crate) command_key: String,
    pub(crate) path: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) timeout_seconds: i64,
    pub(crate) max_output_bytes: i64,
}

impl DeviceCommandRequest {
    /// Decode and validate the request body, rendering the application's 422
    /// body on any pydantic failure.
    pub(crate) fn validated(body: &Value) -> Result<Self, FastApiError> {
        Self::decode(body).map_err(validation_error)
    }

    /// The pydantic validation pass in field declaration order; every failure
    /// is collected into one error list.
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
        let command_key = required_command_key(object, &mut errors);
        let path = optional_string_field(object, "path", &mut errors);
        let args = string_list(object, "args", &mut errors);
        let cwd = optional_string_field(object, "cwd", &mut errors);
        let env = string_map(object, "env", &mut errors);
        let timeout_seconds = bounded_int(
            object,
            "timeout_seconds",
            DEFAULT_COMMAND_TIMEOUT_SECONDS,
            0,
            MAX_COMMAND_TIMEOUT_SECONDS,
            &mut errors,
        );
        let max_output_bytes = bounded_int(
            object,
            "max_output_bytes",
            DEFAULT_MAX_OUTPUT_BYTES,
            0,
            MAX_OUTPUT_BYTES,
            &mut errors,
        );
        match (
            command_key,
            path,
            args,
            cwd,
            env,
            timeout_seconds,
            max_output_bytes,
        ) {
            (
                Some(command_key),
                Some(path),
                Some(args),
                Some(cwd),
                Some(env),
                Some(timeout_seconds),
                Some(max_output_bytes),
            ) if errors.is_empty() => Ok(Self {
                command_key,
                path,
                args,
                cwd,
                env,
                timeout_seconds,
                max_output_bytes,
            }),
            _ => Err(errors),
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

/// `validation_exception_handler`'s 422 body.
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

fn required_command_key(object: &Map<String, Value>, errors: &mut Vec<Value>) -> Option<String> {
    match object.get("command_key") {
        Some(Value::String(text)) if text.is_empty() => {
            errors.push(pydantic_error(
                "string_too_short",
                &["body", "command_key"],
                "String should have at least 1 character",
                &Value::String(text.clone()),
                Some(json!({"min_length": 1})),
            ));
            None
        }
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            errors.push(pydantic_error(
                "string_type",
                &["body", "command_key"],
                "Input should be a valid string",
                other,
                None,
            ));
            None
        }
        None => {
            errors.push(pydantic_error(
                "missing",
                &["body", "command_key"],
                "Field required",
                &Value::Object(object.clone()),
                None,
            ));
            None
        }
    }
}

fn optional_string_field(
    object: &Map<String, Value>,
    field: &str,
    errors: &mut Vec<Value>,
) -> Option<Option<String>> {
    match object.get(field) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(other) => {
            errors.push(pydantic_error(
                "string_type",
                &["body", field],
                "Input should be a valid string",
                other,
                None,
            ));
            None
        }
    }
}

fn string_list(
    object: &Map<String, Value>,
    field: &str,
    errors: &mut Vec<Value>,
) -> Option<Vec<String>> {
    let Some(value) = object.get(field) else {
        return Some(Vec::new());
    };
    let Value::Array(items) = value else {
        errors.push(pydantic_error(
            "list_type",
            &["body", field],
            "Input should be a valid list",
            value,
            None,
        ));
        return None;
    };
    let mut values = Vec::with_capacity(items.len());
    let mut valid = true;
    for (index, item) in items.iter().enumerate() {
        match item {
            Value::String(text) => values.push(text.clone()),
            other => {
                errors.push(pydantic_error(
                    "string_type",
                    &["body", field, &index.to_string()],
                    "Input should be a valid string",
                    other,
                    None,
                ));
                valid = false;
            }
        }
    }
    valid.then_some(values)
}

fn string_map(
    object: &Map<String, Value>,
    field: &str,
    errors: &mut Vec<Value>,
) -> Option<Vec<(String, String)>> {
    let Some(value) = object.get(field) else {
        return Some(Vec::new());
    };
    let Value::Object(members) = value else {
        errors.push(pydantic_error(
            "dict_type",
            &["body", field],
            "Input should be a valid dictionary",
            value,
            None,
        ));
        return None;
    };
    let mut values = Vec::with_capacity(members.len());
    let mut valid = true;
    for (key, item) in members {
        match item {
            Value::String(text) => values.push((key.clone(), text.clone())),
            other => {
                errors.push(pydantic_error(
                    "string_type",
                    &["body", field, key],
                    "Input should be a valid string",
                    other,
                    None,
                ));
                valid = false;
            }
        }
    }
    valid.then_some(values)
}

fn bounded_int(
    object: &Map<String, Value>,
    field: &str,
    default: i64,
    minimum_exclusive: i64,
    maximum: i64,
    errors: &mut Vec<Value>,
) -> Option<i64> {
    let value = match object.get(field) {
        None => default,
        Some(Value::Null) => {
            errors.push(pydantic_error(
                "int_type",
                &["body", field],
                "Input should be a valid integer",
                &Value::Null,
                None,
            ));
            return None;
        }
        Some(Value::Bool(value)) => i64::from(*value),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value) => value,
            None => match number.as_f64() {
                Some(value) if value.is_finite() && value.fract() == 0.0 => value as i64,
                _ => {
                    errors.push(pydantic_error(
                        "int_from_float",
                        &["body", field],
                        "Input should be a valid integer, got a number with a fractional part",
                        &Value::Number(number.clone()),
                        None,
                    ));
                    return None;
                }
            },
        },
        Some(Value::String(text)) => match parse_int_string(text) {
            Some(value) => value,
            None => {
                errors.push(pydantic_error(
                    "int_parsing",
                    &["body", field],
                    "Input should be a valid integer, unable to parse string as an integer",
                    &Value::String(text.clone()),
                    None,
                ));
                return None;
            }
        },
        Some(other) => {
            errors.push(pydantic_error(
                "int_type",
                &["body", field],
                "Input should be a valid integer",
                other,
                None,
            ));
            return None;
        }
    };
    if value <= minimum_exclusive {
        errors.push(pydantic_error(
            "greater_than",
            &["body", field],
            &format!("Input should be greater than {minimum_exclusive}"),
            &json!(value),
            Some(json!({"gt": minimum_exclusive})),
        ));
        return None;
    }
    if value > maximum {
        errors.push(pydantic_error(
            "less_than_equal",
            &["body", field],
            &format!("Input should be less than or equal to {maximum}"),
            &json!(value),
            Some(json!({"le": maximum})),
        ));
        return None;
    }
    Some(value)
}

fn parse_int_string(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(value) = text.parse::<i64>() {
        return Some(value);
    }
    let value = text.parse::<f64>().ok()?;
    (value.is_finite() && value.fract() == 0.0).then_some(value as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_missing_and_bounded_fields() {
        let errors = DeviceCommandRequest::decode(&json!({})).unwrap_err();
        assert_eq!(errors[0]["type"], "missing");
        assert_eq!(errors[0]["loc"], json!(["body", "command_key"]));

        let errors =
            DeviceCommandRequest::decode(&json!({"command_key": "pwd", "timeout_seconds": 0}))
                .unwrap_err();
        assert_eq!(errors[0]["type"], "greater_than");
        assert_eq!(errors[0]["ctx"], json!({"gt": 0}));
    }

    #[test]
    fn accepts_defaults_and_lax_scalars() {
        let request =
            DeviceCommandRequest::decode(&json!({"command_key": "pwd", "timeout_seconds": "15"}))
                .expect("valid request");
        assert_eq!(request.timeout_seconds, 15);
        assert_eq!(request.args, Vec::<String>::new());
        assert!(request.env.is_empty());
        assert_eq!(request.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
    }

    #[test]
    fn rejects_a_null_args_member() {
        let errors =
            DeviceCommandRequest::decode(&json!({"command_key": "pwd", "args": null})).unwrap_err();
        assert_eq!(errors[0]["type"], "list_type");
    }

    #[test]
    fn rejects_an_empty_command_key() {
        let errors = DeviceCommandRequest::decode(&json!({"command_key": ""})).unwrap_err();
        assert_eq!(errors[0]["type"], "string_too_short");
        assert_eq!(errors[0]["ctx"], json!({"min_length": 1}));
    }
}
