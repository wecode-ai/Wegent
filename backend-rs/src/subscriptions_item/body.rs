// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SubscriptionUpdate` request-body parsing for
//! `PUT /api/subscriptions/{subscription_id}`.
//!
//! Mirrors `app.schemas.subscription.SubscriptionUpdate`: FastAPI validates the
//! JSON body against the pydantic model *before* the handler body runs, so a
//! malformed field renders a 422 without any dependency traffic. The update
//! service then reads `subscription_in.model_dump(exclude_unset=True)`, so only
//! the fields present in the request participate; a key sent as `null` is
//! present. [`Update::from_value`] reproduces both contracts.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

/// Minimum `timeout_seconds` (`SUBSCRIPTION_MIN_TIMEOUT_SECONDS`).
const MIN_TIMEOUT_SECONDS: i64 = 60;
/// Maximum `timeout_seconds` (`SUBSCRIPTION_MAX_TIMEOUT_SECONDS`).
const MAX_TIMEOUT_SECONDS: i64 = 24 * 60 * 60;

/// A validated `SubscriptionUpdate`: the present keys with pydantic-coerced
/// values, in request order.
#[derive(Debug)]
pub(crate) struct Update {
    data: Map<String, Value>,
}

impl Update {
    /// Validate a decoded JSON body against `SubscriptionUpdate`.
    pub(crate) fn from_value(value: Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = value else {
            return Err(FastApiError::validation(json!([
                {
                    "type": "model_attributes_type",
                    "loc": ["body"],
                    "msg": "Input should be a valid dictionary or object to extract fields from",
                    "input": value,
                }
            ])));
        };

        let mut data = Map::new();
        for (key, raw) in object {
            validate_field(&mut data, &key, raw)?;
        }
        Ok(Self { data })
    }

    /// `"key" in update_data`.
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.data.contains_key(key)
    }

    /// `update_data.get(key)`.
    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }

    /// A cloned present value.
    pub(crate) fn value(&self, key: &str) -> Option<Value> {
        self.data.get(key).cloned()
    }
}

/// Validate and normalize one present request field.
fn validate_field(
    data: &mut Map<String, Value>,
    key: &str,
    raw: Value,
) -> Result<(), FastApiError> {
    let coerced = match key {
        "display_name" | "description" | "prompt_template" | "git_repo" | "git_domain"
        | "branch_name" => optional_string(key, raw)?,
        "task_type" => optional_enum(
            key,
            raw,
            &["execution", "collection"],
            "Input should be 'execution' or 'collection'",
        )?,
        "visibility" => optional_enum(
            key,
            raw,
            &["public", "private", "market"],
            "Input should be 'public', 'private' or 'market'",
        )?,
        "trigger_type" => optional_enum(
            key,
            raw,
            &["cron", "interval", "one_time", "event"],
            "Input should be 'cron', 'interval', 'one_time' or 'event'",
        )?,
        "team_id" | "workspace_id" | "git_repo_id" => optional_int(key, raw)?,
        "retry_count" => optional_bounded_int(key, raw, 0, 3)?,
        "timeout_seconds" => {
            optional_bounded_int(key, raw, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)?
        }
        "history_message_count" => optional_bounded_int(key, raw, 0, 50)?,
        "force_override_bot_model" | "enabled" | "preserve_history" => optional_bool(key, raw)?,
        "trigger_config" | "model_ref" => optional_object(key, raw)?,
        "market_whitelist_user_ids" => optional_int_list(key, raw)?,
        "knowledge_base_refs" => optional_ref_list(key, raw, &["name", "namespace"])?,
        "skill_refs" => optional_ref_list(key, raw, &["name", "namespace", "is_public"])?,
        "notification_webhooks" => optional_webhook_list(key, raw)?,
        "execution_target" => optional_execution_target(key, raw)?,
        "expires_at" => optional_string_or_null(key, raw)?,
        // pydantic ignores unknown keys by default; they never enter `update_data`.
        _ => return Ok(()),
    };
    data.insert(key.to_string(), coerced);
    Ok(())
}

/// A `loc`-tagged 422 entry matching FastAPI's validation array.
fn field_error(key: &str, kind: &str, message: &str, input: &Value) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["body", key],
            "msg": message,
            "input": input,
        }
    ]))
}

fn optional_string(key: &str, raw: Value) -> Result<Value, FastApiError> {
    match raw {
        Value::String(_) => Ok(raw),
        Value::Null => Ok(Value::Null),
        other => Err(field_error(
            key,
            "string_type",
            "Input should be a valid string",
            &other,
        )),
    }
}

fn optional_string_or_null(key: &str, raw: Value) -> Result<Value, FastApiError> {
    optional_string(key, raw)
}

fn optional_bool(key: &str, raw: Value) -> Result<Value, FastApiError> {
    match raw {
        Value::Bool(_) => Ok(raw),
        Value::Null => Ok(Value::Null),
        other => Err(field_error(
            key,
            "bool_type",
            "Input should be a valid boolean",
            &other,
        )),
    }
}

fn optional_int(key: &str, raw: Value) -> Result<Value, FastApiError> {
    match &raw {
        Value::Number(number) if number.is_i64() => Ok(raw),
        Value::Null => Ok(Value::Null),
        _ => Err(field_error(
            key,
            "int_type",
            "Input should be a valid integer",
            &raw,
        )),
    }
}

fn optional_bounded_int(key: &str, raw: Value, min: i64, max: i64) -> Result<Value, FastApiError> {
    let value = optional_int(key, raw)?;
    let Some(number) = value.as_i64() else {
        return Ok(value);
    };
    if number < min || number > max {
        return Err(field_error(
            key,
            "less_than_equal",
            "Input should be less than or equal to the maximum",
            &value,
        ));
    }
    Ok(value)
}

fn optional_enum(
    key: &str,
    raw: Value,
    allowed: &[&str],
    message: &str,
) -> Result<Value, FastApiError> {
    match &raw {
        Value::String(value) if allowed.contains(&value.as_str()) => Ok(raw),
        Value::Null => Ok(Value::Null),
        _ => Err(field_error(key, "enum", message, &raw)),
    }
}

fn optional_object(key: &str, raw: Value) -> Result<Value, FastApiError> {
    match raw {
        Value::Object(_) => Ok(raw),
        Value::Null => Ok(Value::Null),
        other => Err(field_error(
            key,
            "dict_type",
            "Input should be a valid dictionary",
            &other,
        )),
    }
}

fn optional_int_list(key: &str, raw: Value) -> Result<Value, FastApiError> {
    match raw {
        Value::Null => Ok(Value::Null),
        Value::Array(entries) => {
            for entry in &entries {
                if !entry.is_i64() {
                    return Err(field_error(
                        key,
                        "int_type",
                        "Input should be a valid integer",
                        entry,
                    ));
                }
            }
            Ok(Value::Array(entries))
        }
        other => Err(field_error(
            key,
            "list_type",
            "Input should be a valid list",
            &other,
        )),
    }
}

/// `List[SubscriptionKnowledgeBaseRef]` / `List[SubscriptionSkillRef]`: each
/// entry keeps its declared keys; unknown keys are dropped (`extra=ignore`).
fn optional_ref_list(
    key: &str,
    raw: Value,
    allowed: &[&'static str],
) -> Result<Value, FastApiError> {
    match raw {
        Value::Null => Ok(Value::Null),
        Value::Array(entries) => {
            let mut normalized = Vec::with_capacity(entries.len());
            for entry in entries {
                let Value::Object(object) = entry else {
                    return Err(field_error(
                        key,
                        "model_type",
                        "Input should be a valid dictionary",
                        &entry,
                    ));
                };
                let mut kept = Map::new();
                for name in allowed {
                    if let Some(value) = object.get(*name) {
                        kept.insert((*name).to_string(), value.clone());
                    }
                }
                normalized.push(Value::Object(kept));
            }
            Ok(Value::Array(normalized))
        }
        other => Err(field_error(
            key,
            "list_type",
            "Input should be a valid list",
            &other,
        )),
    }
}

/// `List[NotificationWebhook]`: type, url, secret, enabled.
fn optional_webhook_list(key: &str, raw: Value) -> Result<Value, FastApiError> {
    optional_ref_list(key, raw, &["type", "url", "secret", "enabled"])
}

/// `SubscriptionExecutionTarget`: type enum plus optional device_id.
fn optional_execution_target(key: &str, raw: Value) -> Result<Value, FastApiError> {
    let Value::Object(object) = raw else {
        return match raw {
            Value::Null => Ok(Value::Null),
            other => Err(field_error(
                key,
                "model_type",
                "Input should be a valid dictionary",
                &other,
            )),
        };
    };
    let mut kept = BTreeMap::new();
    if let Some(value) = object.get("type") {
        match value {
            Value::String(kind)
                if ["managed", "local", "cloud", "remote"].contains(&kind.as_str()) => {}
            _ => {
                return Err(field_error(
                    "execution_target.type",
                    "enum",
                    "Input should be 'managed', 'local', 'cloud' or 'remote'",
                    value,
                ));
            }
        }
        kept.insert("type".to_string(), value.clone());
    }
    if let Some(value) = object.get("device_id") {
        if !value.is_string() && !value.is_null() {
            return Err(field_error(
                "execution_target.device_id",
                "string_type",
                "Input should be a valid string",
                value,
            ));
        }
        kept.insert("device_id".to_string(), value.clone());
    }
    Ok(Value::Object(kept.into_iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_keys_are_recorded_and_absent_keys_are_not() {
        let update = Update::from_value(json!({
            "display_name": "x",
            "enabled": false,
            "description": null,
        }))
        .unwrap();
        assert!(update.contains("display_name"));
        assert!(update.contains("enabled"));
        assert!(update.contains("description"));
        assert!(!update.contains("team_id"));
        assert_eq!(update.get("enabled"), Some(&json!(false)));
        assert_eq!(update.get("description"), Some(&Value::Null));
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let update = Update::from_value(json!({"bogus": 1, "enabled": true})).unwrap();
        assert!(!update.contains("bogus"));
        assert!(update.contains("enabled"));
    }

    #[test]
    fn invalid_enum_and_range_render_422() {
        assert!(Update::from_value(json!({"trigger_type": "monthly"})).is_err());
        assert!(Update::from_value(json!({"retry_count": 9})).is_err());
        assert!(Update::from_value(json!({"timeout_seconds": 10})).is_err());
        assert!(Update::from_value(json!({"enabled": "yes"})).is_err());
    }

    #[test]
    fn execution_target_keeps_declared_keys() {
        let update = Update::from_value(json!({
            "execution_target": {"type": "cloud", "device_id": "d1"}
        }))
        .unwrap();
        assert_eq!(
            update.get("execution_target"),
            Some(&json!({"type": "cloud", "device_id": "d1"}))
        );
        assert!(Update::from_value(json!({"execution_target": {"type": "bad"}})).is_err());
    }

    #[test]
    fn nullable_enums_are_allowed() {
        let update = Update::from_value(json!({"visibility": null})).unwrap();
        assert_eq!(update.get("visibility"), Some(&Value::Null));
    }
}
