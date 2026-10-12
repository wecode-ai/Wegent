// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Body validation for
//! `PUT /api/subscriptions/{subscription_id}/developer/notification-settings`.
//!
//! Mirrors `app.schemas.subscription.DeveloperNotificationSettingsUpdateRequest`
//! and its nested `NotificationChannelBindingConfig`. FastAPI validates the JSON
//! body against the pydantic model before the handler runs, so a malformed body
//! renders the application's `validation_exception_handler` 422 body without any
//! dependency traffic:
//! `{"error_code":422,"detail":"Request parameter validation failed","errors":[...]}`.
//! Unknown keys are ignored (`extra=ignore`).

use brz_http_server::StatusCode;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

use super::LEVELS;

/// The `validation_exception_handler` detail line.
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// The validated `PUT` request body.
pub(super) struct UpdateRequest {
    pub(super) notification_level: String,
    pub(super) notification_channel_ids: Option<Vec<i64>>,
    pub(super) channel_binding_configs: Option<Vec<BindingInput>>,
}

/// One validated `NotificationChannelBindingConfig`.
pub(super) struct BindingInput {
    pub(super) channel_id: i64,
    pub(super) bind_private: bool,
    pub(super) bind_group: bool,
    pub(super) group_conversation_id: Option<String>,
    pub(super) group_name: Option<String>,
}

impl UpdateRequest {
    /// Validate a decoded JSON body against
    /// `DeveloperNotificationSettingsUpdateRequest`.
    pub(super) fn from_value(value: Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = value else {
            return Err(validation_error(
                vec!["body"],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                value,
            ));
        };

        let notification_level = match object.get("notification_level") {
            Some(Value::String(level)) if LEVELS.contains(&level.as_str()) => level.clone(),
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "notification_level"],
                    "enum",
                    "Input should be 'silent', 'default' or 'notify'",
                    other.clone(),
                ));
            }
            None => {
                return Err(validation_error(
                    vec!["body", "notification_level"],
                    "missing",
                    "Field required",
                    Value::Null,
                ));
            }
        };

        let notification_channel_ids = match object.get("notification_channel_ids") {
            None | Some(Value::Null) => None,
            Some(Value::Array(entries)) => {
                let mut ids = Vec::with_capacity(entries.len());
                for (index, entry) in entries.iter().enumerate() {
                    match entry {
                        Value::Number(number) if number.is_i64() => {
                            ids.push(number.as_i64().unwrap_or(0));
                        }
                        other => {
                            let index = index.to_string();
                            return Err(validation_error(
                                vec!["body", "notification_channel_ids", &index],
                                "int_type",
                                "Input should be a valid integer",
                                other.clone(),
                            ));
                        }
                    }
                }
                Some(ids)
            }
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "notification_channel_ids"],
                    "list_type",
                    "Input should be a valid list",
                    other.clone(),
                ));
            }
        };

        let channel_binding_configs = match object.get("channel_binding_configs") {
            None | Some(Value::Null) => None,
            Some(Value::Array(entries)) => {
                let mut bindings = Vec::with_capacity(entries.len());
                for (index, entry) in entries.iter().enumerate() {
                    bindings.push(parse_binding(entry, index)?);
                }
                Some(bindings)
            }
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "channel_binding_configs"],
                    "list_type",
                    "Input should be a valid list",
                    other.clone(),
                ));
            }
        };

        Ok(Self {
            notification_level,
            notification_channel_ids,
            channel_binding_configs,
        })
    }
}

/// Validate one `NotificationChannelBindingConfig` list entry.
fn parse_binding(entry: &Value, index: usize) -> Result<BindingInput, FastApiError> {
    let Value::Object(object) = entry else {
        let index = index.to_string();
        return Err(validation_error(
            vec!["body", "channel_binding_configs", &index],
            "model_type",
            "Input should be a valid dictionary",
            entry.clone(),
        ));
    };
    let loc = |field: &str| binding_loc(index, field);

    let channel_id = match object.get("channel_id") {
        Some(Value::Number(number)) if number.is_i64() => number.as_i64().unwrap_or(0),
        Some(other) => {
            return Err(validation_error(
                field_loc(&loc("channel_id")),
                "int_type",
                "Input should be a valid integer",
                other.clone(),
            ));
        }
        None => {
            return Err(validation_error(
                field_loc(&loc("channel_id")),
                "missing",
                "Field required",
                Value::Null,
            ));
        }
    };

    let bind_private = parse_binding_bool(object, "bind_private", true, &loc("bind_private"))?;
    let bind_group = parse_binding_bool(object, "bind_group", false, &loc("bind_group"))?;
    let group_conversation_id = parse_binding_optional_string(
        object,
        "group_conversation_id",
        &loc("group_conversation_id"),
    )?;
    let group_name = parse_binding_optional_string(object, "group_name", &loc("group_name"))?;

    Ok(BindingInput {
        channel_id,
        bind_private,
        bind_group,
        group_conversation_id,
        group_name,
    })
}

/// A `loc` path for one `channel_binding_configs[index].field` entry.
fn binding_loc(index: usize, field: &str) -> [String; 4] {
    [
        "body".to_string(),
        "channel_binding_configs".to_string(),
        index.to_string(),
        field.to_string(),
    ]
}

/// Borrow a `[String; 4]` loc path as the `&str` slice the 422 body takes.
fn field_loc(loc: &[String; 4]) -> Vec<&str> {
    loc.iter().map(String::as_str).collect()
}

/// A `bool` field with a pydantic default.
fn parse_binding_bool(
    object: &Map<String, Value>,
    field: &str,
    default: bool,
    loc: &[String; 4],
) -> Result<bool, FastApiError> {
    match object.get(field) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(other) => Err(validation_error(
            field_loc(loc),
            "bool_type",
            "Input should be a valid boolean",
            other.clone(),
        )),
    }
}

/// An `Optional[str]` field (present `null` stays `None`).
fn parse_binding_optional_string(
    object: &Map<String, Value>,
    field: &str,
    loc: &[String; 4],
) -> Result<Option<String>, FastApiError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(other) => Err(validation_error(
            field_loc(loc),
            "string_type",
            "Input should be a valid string",
            other.clone(),
        )),
    }
}

/// `{"error_code":422,"detail":"Request parameter validation failed","errors":[...]}`
/// — the source `validation_exception_handler` body.
fn validation_error(location: Vec<&str>, kind: &str, message: &str, input: Value) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "error_code": 422,
            "detail": VALIDATION_FAILED,
            "errors": [
                {"type": kind, "loc": location, "msg": message, "input": input},
            ],
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_the_notification_level() {
        assert!(UpdateRequest::from_value(json!({"notification_channel_ids": []})).is_err());
        assert!(UpdateRequest::from_value(json!({"notification_level": "loud"})).is_err());
        assert!(UpdateRequest::from_value(json!({"notification_level": "notify"})).is_ok());
        assert!(UpdateRequest::from_value(json!([])).is_err());
    }

    #[test]
    fn parses_binding_configs_and_ignores_unknown_keys() {
        let request = UpdateRequest::from_value(json!({
            "notification_level": "notify",
            "notification_channel_ids": [1, 2],
            "channel_binding_configs": [{"channel_id": 9, "bind_group": true, "extra": 1}],
            "ignored": true,
        }))
        .unwrap();
        assert_eq!(request.notification_level, "notify");
        assert_eq!(request.notification_channel_ids, Some(vec![1, 2]));
        let bindings = request.channel_binding_configs.unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].channel_id, 9);
        assert!(bindings[0].bind_private);
        assert!(bindings[0].bind_group);
        assert!(bindings[0].group_name.is_none());
    }

    #[test]
    fn binding_configs_require_a_channel_id() {
        assert!(
            UpdateRequest::from_value(json!({
                "notification_level": "notify",
                "channel_binding_configs": [{"bind_group": true}],
            }))
            .is_err()
        );
        assert!(
            UpdateRequest::from_value(json!({
                "notification_level": "notify",
                "channel_binding_configs": [{"channel_id": "9"}],
            }))
            .is_err()
        );
    }
}
