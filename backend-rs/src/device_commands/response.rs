// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DeviceCommandResponse` pydantic-compatible validation for
//! `POST /api/devices/{device_id}/commands`.
//!
//! The executor acknowledgement is validated by
//! `DeviceCommandResponse(**result)` in the source; a validation failure is an
//! unhandled server error, not a mapped device error.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

use super::unhandled;

/// `DeviceCommandResponse`: serialized in field declaration order.
#[derive(Debug, Serialize)]
pub(crate) struct DeviceCommandResponse {
    success: bool,
    exit_code: Option<i64>,
    stdout: Value,
    stderr: String,
    duration: f64,
    timed_out: bool,
    error: Option<String>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

/// `DeviceCommandResponse(**result)`.
pub(crate) fn response_from_result(
    result: Map<String, Value>,
) -> Result<DeviceCommandResponse, FastApiError> {
    let success = required_bool(&result, "success")?;
    let exit_code = optional_int(&result, "exit_code")?;
    let stdout = stdout_value(&result)?;
    let stderr = optional_string(&result, "stderr")?.unwrap_or_default();
    let duration = required_float(&result, "duration")?;
    let timed_out = optional_bool(&result, "timed_out")?.unwrap_or(false);
    let error = optional_string(&result, "error")?;
    let stdout_truncated = optional_bool(&result, "stdout_truncated")?.unwrap_or(false);
    let stderr_truncated = optional_bool(&result, "stderr_truncated")?.unwrap_or(false);
    Ok(DeviceCommandResponse {
        success,
        exit_code,
        stdout,
        stderr,
        duration,
        timed_out,
        error,
        stdout_truncated,
        stderr_truncated,
    })
}

fn required_bool(result: &Map<String, Value>, field: &str) -> Result<bool, FastApiError> {
    match result.get(field) {
        Some(value) => bool_value(value).ok_or_else(unhandled),
        None => Err(unhandled()),
    }
}

fn optional_bool(result: &Map<String, Value>, field: &str) -> Result<Option<bool>, FastApiError> {
    match result.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => bool_value(value).map(Some).ok_or_else(unhandled),
    }
}

fn bool_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(number) => match number.as_f64() {
            Some(0.0) => Some(false),
            Some(1.0) => Some(true),
            _ => None,
        },
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "yes" | "y" | "on" | "1" => Some(true),
            "false" | "f" | "no" | "n" | "off" | "0" => Some(false),
            _ => None,
        },
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn optional_int(result: &Map<String, Value>, field: &str) -> Result<Option<i64>, FastApiError> {
    match result.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => int_value(value).map(Some).ok_or_else(unhandled),
    }
}

fn int_value(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(value) => Some(i64::from(*value)),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                return Some(value);
            }
            let value = number.as_f64()?;
            (value.is_finite() && value.fract() == 0.0).then_some(value as i64)
        }
        Value::String(text) => {
            let text = text.trim();
            if let Ok(value) = text.parse::<i64>() {
                return Some(value);
            }
            let value = text.parse::<f64>().ok()?;
            (value.is_finite() && value.fract() == 0.0).then_some(value as i64)
        }
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn required_float(result: &Map<String, Value>, field: &str) -> Result<f64, FastApiError> {
    match result.get(field) {
        Some(value) => float_value(value).ok_or_else(unhandled),
        None => Err(unhandled()),
    }
}

fn float_value(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(value) => Some(f64::from(u8::from(*value))),
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn optional_string(
    result: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, FastApiError> {
    match result.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(unhandled()),
    }
}

/// `stdout: Union[str, Dict[str, Any], List[str], List[Dict[str, Any]]]`.
fn stdout_value(result: &Map<String, Value>) -> Result<Value, FastApiError> {
    match result.get("stdout") {
        None => Ok(Value::String(String::new())),
        Some(value @ Value::String(_)) => Ok(value.clone()),
        Some(value @ Value::Object(_)) => Ok(value.clone()),
        Some(Value::Array(items))
            if items.iter().all(Value::is_string) || items.iter().all(Value::is_object) =>
        {
            Ok(Value::Array(items.clone()))
        }
        Some(_) => Err(unhandled()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_pydantic_model() {
        let response = response_from_result(
            json!({"success": false, "duration": 0.5})
                .as_object()
                .unwrap()
                .clone(),
        )
        .expect("valid response");
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            json!({
                "success": false,
                "exit_code": null,
                "stdout": "",
                "stderr": "",
                "duration": 0.5,
                "timed_out": false,
                "error": null,
                "stdout_truncated": false,
                "stderr_truncated": false,
            })
        );
    }

    #[test]
    fn rejects_values_pydantic_rejects() {
        for value in [
            json!({"duration": 1}),
            json!({"success": true}),
            json!({"success": true, "duration": "x"}),
            json!({"success": true, "duration": 1, "stdout": 1}),
            json!({"success": true, "duration": 1, "stdout": ["a", 1]}),
            json!({"success": true, "duration": 1, "stderr": 1}),
        ] {
            assert!(
                response_from_result(value.as_object().unwrap().clone()).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn accepts_pydantic_lax_coercions() {
        let response = response_from_result(
            json!({
                "success": 1,
                "exit_code": "3",
                "duration": "0.5",
                "timed_out": 1,
                "stdout": [{"a": 1}],
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .expect("valid response");
        assert!(response.success);
        assert_eq!(response.exit_code, Some(3));
        assert_eq!(response.duration, 0.5);
        assert!(response.timed_out);
        assert_eq!(response.stdout, json!([{"a": 1}]));
    }
}
