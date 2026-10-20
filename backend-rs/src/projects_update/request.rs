// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/projects/{project_id}` request decoding:
//! `app.schemas.project.ProjectUpdate` (`extra="ignore"`), reproduced with
//! pydantic's per-field validation and `model_dump(exclude_unset=True)`
//! set-tracking semantics (an explicit JSON `null` is a set `None`).
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

use super::super::StoredProjectConfig;
use super::config::validate_project_config;

/// The `update_project` body: the six updatable fields, each `Set` only when
/// the request carried the key (an explicit JSON `null` is a set `None`).
#[derive(Debug)]
pub(super) struct ProjectUpdateRequest {
    pub(super) name: Field<Option<String>>,
    pub(super) description: Field<Option<String>>,
    pub(super) color: Field<Option<String>>,
    pub(super) sort_order: Field<Option<i64>>,
    pub(super) is_expanded: Field<Option<bool>>,
    pub(super) config: Field<Option<StoredProjectConfig>>,
}

/// One `model_dump(exclude_unset=True)` entry: `Unset` when the request
/// omitted the key, `Set(value)` otherwise.
pub(super) enum Field<T> {
    Unset,
    Set(T),
}

impl<T: std::fmt::Debug> std::fmt::Debug for Field<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unset => f.write_str("Unset"),
            Self::Set(value) => write!(f, "Set({value:?})"),
        }
    }
}

impl ProjectUpdateRequest {
    /// Decode and validate the body (`app.schemas.project.ProjectUpdate`,
    /// `extra="ignore"`). A malformed field renders FastAPI's 422
    /// request-validation body, which happens before the endpoint's own
    /// `try/except`.
    pub(super) fn decode(body: &Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = body else {
            return Err(body_error(
                "model_attributes_type",
                "body",
                "Input should be a valid dictionary or object to extract fields from",
                body,
            ));
        };
        Ok(Self {
            name: optional_name(object)?,
            description: optional_description(object)?,
            color: optional_color(object)?,
            sort_order: optional_sort_order(object)?,
            is_expanded: optional_is_expanded(object)?,
            config: optional_config(object)?,
        })
    }
}

/// `name: Optional[str]` with `min_length=1, max_length=100`.
fn optional_name(object: &Map<String, Value>) -> Result<Field<Option<String>>, FastApiError> {
    match object.get("name") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(Value::String(text)) if text.is_empty() => Err(body_error(
            "string_too_short",
            "name",
            "String should have at least 1 character",
            &Value::String(text.clone()),
        )),
        Some(Value::String(text)) if text.chars().count() > 100 => Err(body_error(
            "string_too_long",
            "name",
            "String should have at most 100 characters",
            &Value::String(text.clone()),
        )),
        Some(Value::String(text)) => Ok(Field::Set(Some(text.clone()))),
        Some(other) => Err(body_error(
            "string_type",
            "name",
            "Input should be a valid string",
            other,
        )),
    }
}

/// `description: Optional[str]` (unconstrained).
fn optional_description(
    object: &Map<String, Value>,
) -> Result<Field<Option<String>>, FastApiError> {
    match object.get("description") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(Value::String(text)) => Ok(Field::Set(Some(text.clone()))),
        Some(other) => Err(body_error(
            "string_type",
            "description",
            "Input should be a valid string",
            other,
        )),
    }
}

/// `color: Optional[str]` with `max_length=20`.
fn optional_color(object: &Map<String, Value>) -> Result<Field<Option<String>>, FastApiError> {
    match object.get("color") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(Value::String(text)) if text.chars().count() > 20 => Err(body_error(
            "string_too_long",
            "color",
            "String should have at most 20 characters",
            &Value::String(text.clone()),
        )),
        Some(Value::String(text)) => Ok(Field::Set(Some(text.clone()))),
        Some(other) => Err(body_error(
            "string_type",
            "color",
            "Input should be a valid string",
            other,
        )),
    }
}

/// `sort_order: Optional[int]`: an integer (or a bool, which pydantic accepts
/// as `0`/`1`), or a float with a zero fractional part; anything else is an
/// `int_parsing` error.
fn optional_sort_order(object: &Map<String, Value>) -> Result<Field<Option<i64>>, FastApiError> {
    match object.get("sort_order") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(Value::Bool(value)) => Ok(Field::Set(Some(i64::from(*value)))),
        Some(Value::Number(number)) => {
            if let Some(value) = number.as_i64() {
                Ok(Field::Set(Some(value)))
            } else if let Some(value) = number.as_f64() {
                if value.fract() == 0.0 {
                    Ok(Field::Set(Some(value as i64)))
                } else {
                    Err(body_error(
                        "int_from_float",
                        "sort_order",
                        "Input should be a valid integer, got a number with a fractional part",
                        &Value::Number(number.clone()),
                    ))
                }
            } else {
                Err(body_error(
                    "int_type",
                    "sort_order",
                    "Input should be a valid integer",
                    &Value::Number(number.clone()),
                ))
            }
        }
        Some(other) => Err(body_error(
            "int_parsing",
            "sort_order",
            "Input should be a valid integer, unable to parse string as an integer",
            other,
        )),
    }
}

/// `is_expanded: Optional[bool]`: pydantic's boolean rules — `true`/`false`
/// (case-insensitive), `1`/`0`, `yes`/`no`, `on`/`off`, `t`/`f`, `y`/`n`, and
/// the integers `0`/`1`.
fn optional_is_expanded(object: &Map<String, Value>) -> Result<Field<Option<bool>>, FastApiError> {
    match object.get("is_expanded") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(Value::Bool(value)) => Ok(Field::Set(Some(*value))),
        Some(Value::Number(number)) if number.as_i64() == Some(0) => Ok(Field::Set(Some(false))),
        Some(Value::Number(number)) if number.as_i64() == Some(1) => Ok(Field::Set(Some(true))),
        Some(other @ Value::Number(_)) => Err(body_error(
            "bool_parsing",
            "is_expanded",
            "Input should be a valid boolean, unable to interpret input",
            other,
        )),
        Some(Value::String(text)) => match text.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" | "t" | "y" => Ok(Field::Set(Some(true))),
            "false" | "0" | "no" | "off" | "f" | "n" => Ok(Field::Set(Some(false))),
            _ => Err(body_error(
                "bool_parsing",
                "is_expanded",
                "Input should be a valid boolean, unable to interpret input",
                &Value::String(text.clone()),
            )),
        },
        Some(other) => Err(body_error(
            "bool_type",
            "is_expanded",
            "Input should be a valid boolean",
            other,
        )),
    }
}

/// `config: Optional[ProjectConfig]`.
fn optional_config(
    object: &Map<String, Value>,
) -> Result<Field<Option<StoredProjectConfig>>, FastApiError> {
    match object.get("config") {
        None => Ok(Field::Unset),
        Some(Value::Null) => Ok(Field::Set(None)),
        Some(value @ Value::Object(_)) => Ok(Field::Set(Some(validate_project_config(value)?))),
        Some(other) => Err(body_error(
            "model_type",
            "config",
            "Input should be a valid dictionary or instance of ProjectConfig",
            other,
        )),
    }
}

/// One FastAPI body-validation error entry at `loc`.
fn body_error(kind: &str, loc: &str, message: &str, input: &Value) -> FastApiError {
    FastApiError::validation(serde_json::json!([{
        "type": kind,
        "loc": ["body", loc],
        "msg": message,
        "input": input,
    }]))
}

/// One FastAPI body-validation error entry at a nested `config` location.
pub(super) fn config_error(loc: &[&str], kind: &str, message: &str, input: &Value) -> FastApiError {
    let location: Vec<Value> = std::iter::once(Value::String("body".to_string()))
        .chain(loc.iter().map(|part| Value::String((*part).to_string())))
        .collect();
    FastApiError::validation(serde_json::json!([{
        "type": kind,
        "loc": location,
        "msg": message,
        "input": input,
    }]))
}
