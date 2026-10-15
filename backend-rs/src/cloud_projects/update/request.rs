// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PATCH /api/v1/cloud-projects/{project_id}` request decoding:
//! `app.schemas.cloud_project.CloudProjectUpdate` and the nested update
//! schemas.
//!
//! The service merge depends on two pydantic behaviours this module
//! reproduces:
//!
//! - `model_fields_set`: whether a key was present in the request body. The
//!   metadata merge runs only when one of the metadata-backed fields is
//!   present, so a field sent as JSON `null` still triggers the branch while
//!   contributing no value.
//! - `model_dump(exclude={"version"}, exclude_none=True)`: the metadata
//!   branches persist `values.<field>.model_dump()`, i.e. every declared key
//!   of the nested schema in declaration order, with the schema defaults
//!   filled in.
use serde_json::{Map, Value};

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `app.schemas.tagging.MAX_TAGS_PER_ITEM`.
const MAX_TAGS_PER_ITEM: usize = 20;
/// `app.schemas.tagging.MAX_TAG_LENGTH`.
const MAX_TAG_LENGTH: usize = 32;
/// `CloudProjectUpdate.name` bounds.
const NAME_MIN: usize = 1;
const NAME_MAX: usize = 100;

/// The body field names of `CloudProjectUpdate`.
const FIELD_NAME: &str = "name";
const FIELD_DESCRIPTION: &str = "description";
const FIELD_TAGS: &str = "tags";
pub(super) const FIELD_PROVIDER_CONFIG: &str = "provider_config";
const FIELD_VISIBILITY: &str = "visibility";
pub(super) const FIELD_PUBLIC_ACCESS: &str = "public_access";
const FIELD_DEFAULT_ISSUE_SECURITY: &str = "default_issue_security";
pub(super) const FIELD_CARD_DISPLAY: &str = "card_display";
pub(super) const FIELD_BOARD_CONFIG: &str = "board_config";
pub(super) const FIELD_AI_AUTOMATION: &str = "ai_automation";
pub(super) const FIELD_PULL_REQUEST_AUTOMATION: &str = "pull_request_automation";
pub(super) const FIELD_WORKFLOW_DEFINITION: &str = "workflow_definition";
pub(super) const FIELD_EXECUTION_ENVIRONMENT: &str = "execution_environment";
const FIELD_VERSION: &str = "version";

/// Fields whose presence routes the update through the metadata merge.
const METADATA_FIELDS: [&str; 11] = [
    FIELD_TAGS,
    FIELD_PROVIDER_CONFIG,
    FIELD_CARD_DISPLAY,
    FIELD_BOARD_CONFIG,
    FIELD_AI_AUTOMATION,
    FIELD_PULL_REQUEST_AUTOMATION,
    FIELD_WORKFLOW_DEFINITION,
    FIELD_EXECUTION_ENVIRONMENT,
    FIELD_VISIBILITY,
    FIELD_PUBLIC_ACCESS,
    FIELD_DEFAULT_ISSUE_SECURITY,
];

use super::fields::{
    ai_automation_value, board_config_value, card_display_value, execution_environment_value,
    provider_config_value, public_access_value, pull_request_automation_value,
    workflow_definition_value,
};

/// `CloudProjectUpdate` as the service merge consumes it: the present keys
/// plus every decoded field (`None` when absent or JSON `null`).
#[derive(Debug, Default)]
pub(super) struct CloudProjectUpdate {
    /// `model_fields_set`: request keys that were present.
    present: Vec<&'static str>,
    pub(super) name: Option<String>,
    pub(super) description: Option<String>,
    /// Already normalized by the `normalize_tag_list` field validator.
    pub(super) tags: Option<Vec<String>>,
    pub(super) provider_config: Option<Map<String, Value>>,
    pub(super) visibility: Option<String>,
    pub(super) public_access: Option<Value>,
    pub(super) default_issue_security: Option<String>,
    pub(super) card_display: Option<Value>,
    pub(super) board_config: Option<Value>,
    pub(super) ai_automation: Option<Value>,
    pub(super) pull_request_automation: Option<Value>,
    pub(super) workflow_definition: Option<Value>,
    pub(super) execution_environment: Option<Value>,
    pub(super) version: i64,
}

impl CloudProjectUpdate {
    /// `"<field>" in values.model_fields_set`.
    pub(super) fn has(&self, field: &str) -> bool {
        self.present.contains(&field)
    }

    /// Whether the metadata merge branch runs for this request.
    pub(super) fn touches_metadata(&self) -> bool {
        METADATA_FIELDS.iter().any(|field| self.has(field))
    }

    /// Decode and validate a `CloudProjectUpdate` body (FastAPI 422 on any
    /// failure).
    pub(super) fn decode(body: &Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = body else {
            return Err(field_error(
                &[],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                body,
            ));
        };

        let mut present = Vec::new();
        let mut update = Self::default();
        for field in [
            FIELD_NAME,
            FIELD_DESCRIPTION,
            FIELD_TAGS,
            FIELD_PROVIDER_CONFIG,
            FIELD_VISIBILITY,
            FIELD_PUBLIC_ACCESS,
            FIELD_DEFAULT_ISSUE_SECURITY,
            FIELD_CARD_DISPLAY,
            FIELD_BOARD_CONFIG,
            FIELD_AI_AUTOMATION,
            FIELD_PULL_REQUEST_AUTOMATION,
            FIELD_WORKFLOW_DEFINITION,
            FIELD_EXECUTION_ENVIRONMENT,
            FIELD_VERSION,
        ] {
            if object.contains_key(field) {
                present.push(field);
            }
        }

        if let Some(value) = present_value(object, FIELD_NAME) {
            update.name = Some(name_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_DESCRIPTION) {
            update.description = Some(string_value(FIELD_DESCRIPTION, value)?.to_owned());
        }
        if let Some(value) = present_value(object, FIELD_TAGS) {
            // `normalize_tag_list` runs `mode="before"`, so any value becomes a
            // tag list before the `max_length` check.
            update.tags = Some(normalize_tags(value));
        }
        if let Some(value) = present_value(object, FIELD_PROVIDER_CONFIG) {
            update.provider_config = Some(provider_config_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_VISIBILITY) {
            update.visibility = Some(literal(FIELD_VISIBILITY, value, &["private", "public"])?);
        }
        if let Some(value) = present_value(object, FIELD_PUBLIC_ACCESS) {
            update.public_access = Some(public_access_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_DEFAULT_ISSUE_SECURITY) {
            update.default_issue_security = Some(literal(
                FIELD_DEFAULT_ISSUE_SECURITY,
                value,
                &["open", "related"],
            )?);
        }
        if let Some(value) = present_value(object, FIELD_CARD_DISPLAY) {
            update.card_display = Some(card_display_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_BOARD_CONFIG) {
            update.board_config = Some(board_config_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_AI_AUTOMATION) {
            update.ai_automation = Some(ai_automation_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_PULL_REQUEST_AUTOMATION) {
            update.pull_request_automation = Some(pull_request_automation_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_WORKFLOW_DEFINITION) {
            update.workflow_definition = Some(workflow_definition_value(value)?);
        }
        if let Some(value) = present_value(object, FIELD_EXECUTION_ENVIRONMENT) {
            update.execution_environment = Some(execution_environment_value(value)?);
        }
        // `version: int = Field(ge=1)` is required; a missing key is a
        // `missing` error and any other shape a parsing error.
        update.version = match object.get(FIELD_VERSION) {
            None => {
                return Err(field_error(
                    &[FIELD_VERSION],
                    "missing",
                    "Field required",
                    &Value::Null,
                ));
            }
            Some(value) => version_value(value)?,
        };
        update.present = present;

        // `CloudProjectUpdate.validate_provider`: the immutable-provider and
        // credential guards that run after field validation.
        if update.visibility.as_deref() == Some("private") && update.public_access.is_some() {
            return Err(value_error("Private projects cannot grant public access"));
        }
        if let Some(config) = update.provider_config.as_mut() {
            if config.contains_key("credential") {
                return Err(value_error(
                    "encrypted provider credentials cannot be supplied",
                ));
            }
            if let Some(token) = config.get("token") {
                let Some(text) = token.as_str() else {
                    return Err(value_error("provider token must be a string"));
                };
                config.insert("token".to_owned(), Value::String(text.trim().to_owned()));
            }
        }
        Ok(update)
    }

    /// `values.model_dump(exclude={"version"}, exclude_none=True)`: the direct
    /// `loop_items` columns the UPDATE writes. Only `name` and `description`
    /// survive; every metadata-backed field is popped by the merge.
    pub(super) fn direct_columns(&self) -> Vec<(&'static str, String)> {
        // The metadata-backed keys are popped before the UPDATE, so `updates`
        // can only carry `name`/`description` and (added by the merge)
        // `metadata_json`.
        match (&self.name, &self.description) {
            (Some(name), Some(description)) => {
                vec![("name", name.clone()), ("description", description.clone())]
            }
            (Some(name), None) => vec![("name", name.clone())],
            (None, Some(description)) => vec![("description", description.clone())],
            (None, None) => Vec::new(),
        }
    }
}

/// `object[field]` when present and not JSON `null`.
fn present_value<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a Value> {
    object.get(field).filter(|value| !value.is_null())
}

/// `app.schemas.tagging.normalize_tags`: trim, dedupe, cap. Non-list input
/// becomes an empty list.
fn normalize_tags(value: &Value) -> Vec<String> {
    let Value::Array(items) = value else {
        return Vec::new();
    };
    let mut tags: Vec<String> = Vec::new();
    for raw in items {
        let rendered = python_str(raw);
        let tag: String = rendered.trim().chars().take(MAX_TAG_LENGTH).collect();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
        if tags.len() >= MAX_TAGS_PER_ITEM {
            break;
        }
    }
    tags
}

/// Python's `str()` for the scalar JSON values `normalize_tags` renders;
/// containers fall back to their JSON text.
fn python_str(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn name_value(value: &Value) -> Result<String, FastApiError> {
    let text = string_value(FIELD_NAME, value)?;
    let characters = text.chars().count();
    if characters < NAME_MIN {
        return Err(field_error(
            &[FIELD_NAME],
            "string_too_short",
            "String should have at least 1 character",
            value,
        ));
    }
    if characters > NAME_MAX {
        return Err(field_error(
            &[FIELD_NAME],
            "string_too_long",
            "String should have at most 100 characters",
            value,
        ));
    }
    Ok(text.to_owned())
}

pub(super) fn string_value<'a>(field: &str, value: &'a Value) -> Result<&'a str, FastApiError> {
    value.as_str().ok_or_else(|| {
        field_error(
            &[field],
            "string_type",
            "Input should be a valid string",
            value,
        )
    })
}

/// A pydantic `Literal[...]` field.
pub(super) fn literal(
    field: &str,
    value: &Value,
    allowed: &[&str],
) -> Result<String, FastApiError> {
    match value.as_str() {
        Some(text) if allowed.contains(&text) => Ok(text.to_owned()),
        _ => Err(field_error(
            &[field],
            "literal_error",
            &format!(
                "Input should be {}",
                allowed
                    .iter()
                    .map(|item| format!("'{item}'"))
                    .collect::<Vec<_>>()
                    .join(" or ")
            ),
            value,
        )),
    }
}

fn version_value(value: &Value) -> Result<i64, FastApiError> {
    let Some(number) = value.as_i64().filter(|_| !value.is_boolean()) else {
        return Err(field_error(
            &[FIELD_VERSION],
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
        ));
    };
    if number < 1 {
        return Err(field_error(
            &[FIELD_VERSION],
            "greater_than_equal",
            "Input should be greater than or equal to 1",
            value,
        ));
    }
    Ok(number)
}

pub(super) fn model_object<'a>(
    field: &str,
    value: &'a Value,
) -> Result<&'a Map<String, Value>, FastApiError> {
    match value {
        Value::Object(object) => Ok(object),
        other => Err(field_error(
            &[field],
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            other,
        )),
    }
}

pub(super) fn model_object_at<'a>(
    loc: &[&str],
    value: &'a Value,
) -> Result<&'a Map<String, Value>, FastApiError> {
    match value {
        Value::Object(object) => Ok(object),
        other => Err(field_error(
            loc,
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            other,
        )),
    }
}

pub(super) fn required_string(loc: &[&str], value: Option<&Value>) -> Result<String, FastApiError> {
    match value {
        None => Err(field_error(loc, "missing", "Field required", &Value::Null)),
        Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
        Some(Value::String(_)) => Err(field_error(
            loc,
            "string_too_short",
            "String should have at least 1 character",
            value.unwrap_or(&Value::Null),
        )),
        Some(other) => Err(field_error(
            loc,
            "string_type",
            "Input should be a valid string",
            other,
        )),
    }
}

/// A pydantic lax `bool` field.
pub(super) fn bool_value(loc: &[&str], value: &Value) -> Result<bool, FastApiError> {
    match value {
        Value::Bool(flag) => Ok(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(bool_error(loc, value)),
        },
        Value::String(text) => match text.as_str() {
            "true" | "True" | "1" | "yes" | "on" => Ok(true),
            "false" | "False" | "0" | "no" | "off" => Ok(false),
            _ => Err(bool_error(loc, value)),
        },
        _ => Err(bool_error(loc, value)),
    }
}

fn bool_error(loc: &[&str], value: &Value) -> FastApiError {
    field_error(
        loc,
        "bool_parsing",
        "Input should be a valid boolean, unable to interpret input",
        value,
    )
}

/// A pydantic request-validation entry with `loc = ["body", ..field]`.
pub(super) fn field_error(
    field_path: &[&str],
    error_type: &str,
    message: &str,
    input: &Value,
) -> FastApiError {
    let mut loc = vec![Value::String("body".to_owned())];
    loc.extend(
        field_path
            .iter()
            .map(|part| Value::String((*part).to_owned())),
    );
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "detail": [{
                "type": error_type,
                "loc": loc,
                "msg": message,
                "input": input,
            }]
        }),
    )
}

/// A pydantic `model_validator` failure (`type: "value_error"`).
pub(super) fn value_error(message: &str) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "detail": [{
                "type": "value_error",
                "loc": ["body"],
                "msg": format!("Value error, {message}"),
                "input": Value::Null,
            }]
        }),
    )
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
