// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SubscriptionCreate` request-body validation for
//! `POST /api/subscriptions`.
//!
//! FastAPI validates the JSON body against `app.schemas.subscription
//! .SubscriptionCreate` *before* the handler body runs, so a missing required
//! field or a bad type/enum/range renders a 422 without any dependency traffic.
//! pydantic applies the declared defaults for absent optional fields and
//! ignores unknown keys; [`Create::from_value`] reproduces both contracts so the
//! service can read every field the source reads.

use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::subscriptions_list::convert::pydantic_datetime;

use super::Create;

/// `SUBSCRIPTION_MIN_TIMEOUT_SECONDS`.
const MIN_TIMEOUT_SECONDS: i64 = 60;
/// `SUBSCRIPTION_MAX_TIMEOUT_SECONDS`.
const MAX_TIMEOUT_SECONDS: i64 = 24 * 60 * 60;

impl Create {
    /// Validate a decoded JSON body against `SubscriptionCreate`.
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
        Validator {
            object,
            errors: Vec::new(),
        }
        .run()
    }
}

/// A body object plus the accumulated pydantic-style validation errors.
struct Validator {
    object: Map<String, Value>,
    errors: Vec<Value>,
}

impl Validator {
    fn run(mut self) -> Result<Create, FastApiError> {
        // Field declaration order matches `SubscriptionBase`.
        let name = self.optional_string("name");
        let display_name = self.required_string("display_name");
        let description = self.optional_string("description");
        let task_type = self.enum_or("task_type", "collection", &["execution", "collection"]);
        let visibility = self.enum_or("visibility", "private", &["public", "private", "market"]);
        let trigger_type =
            self.required_enum("trigger_type", &["cron", "interval", "one_time", "event"]);
        let trigger_config = self.required_object("trigger_config");
        let team_id = self.required_int("team_id");
        let workspace_id = self.optional_int("workspace_id");
        let git_repo = self.optional_string("git_repo");
        let git_repo_id = self.optional_int("git_repo_id");
        let git_domain = self.optional_string("git_domain");
        let branch_name = self.optional_string("branch_name");
        let model_ref = self.optional_string_map("model_ref");
        let force_override_bot_model = self.bool_or("force_override_bot_model", false);
        let prompt_template = self.required_string("prompt_template");
        let retry_count = self.bounded_int_or("retry_count", 0, 0, 3);
        let timeout_seconds = self.bounded_int_or(
            "timeout_seconds",
            600,
            MIN_TIMEOUT_SECONDS,
            MAX_TIMEOUT_SECONDS,
        );
        let enabled = self.bool_or("enabled", true);
        let execution_target = self.execution_target();
        let preserve_history = self.bool_or("preserve_history", false);
        let history_message_count = self.bounded_int_or("history_message_count", 10, 0, 50);
        let knowledge_base_refs = self.knowledge_base_refs("knowledge_base_refs");
        let notification_webhooks = self.notification_webhooks("notification_webhooks");
        let skill_refs = self.skill_refs("skill_refs");
        let market_whitelist_user_ids = self.optional_int_list("market_whitelist_user_ids");
        let namespace = self
            .optional_string("namespace")
            .unwrap_or_else(|| "default".to_string());
        let expires_at = self.optional_datetime("expires_at");

        if !self.errors.is_empty() {
            return Err(FastApiError::validation(Value::Array(self.errors)));
        }
        Ok(Create {
            name,
            display_name,
            description,
            task_type,
            visibility,
            trigger_type,
            trigger_config,
            team_id,
            workspace_id,
            git_repo,
            git_repo_id,
            git_domain,
            branch_name,
            model_ref,
            force_override_bot_model,
            prompt_template,
            retry_count,
            timeout_seconds,
            enabled,
            execution_target,
            preserve_history,
            history_message_count,
            knowledge_base_refs,
            notification_webhooks,
            skill_refs,
            market_whitelist_user_ids,
            namespace,
            expires_at,
        })
    }

    fn required_string(&mut self, key: &str) -> String {
        match self.object.get(key).cloned() {
            Some(Value::String(value)) => value,
            None => {
                self.errors.push(missing_error(key));
                String::new()
            }
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "string_type",
                    "Input should be a valid string",
                    &other,
                ));
                String::new()
            }
        }
    }

    fn optional_string(&mut self, key: &str) -> Option<String> {
        match self.object.get(key).cloned() {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value),
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "string_type",
                    "Input should be a valid string",
                    &other,
                ));
                None
            }
        }
    }

    fn required_int(&mut self, key: &str) -> i64 {
        match self.object.get(key).cloned() {
            Some(Value::Number(number)) if number.is_i64() => number.as_i64().unwrap_or(0),
            None => {
                self.errors.push(missing_error(key));
                0
            }
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "int_type",
                    "Input should be a valid integer",
                    &other,
                ));
                0
            }
        }
    }

    fn optional_int(&mut self, key: &str) -> Option<i64> {
        match self.object.get(key).cloned() {
            None | Some(Value::Null) => None,
            Some(Value::Number(number)) if number.is_i64() => number.as_i64(),
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "int_type",
                    "Input should be a valid integer",
                    &other,
                ));
                None
            }
        }
    }

    fn bool_or(&mut self, key: &str, default: bool) -> bool {
        match self.object.get(key).cloned() {
            None | Some(Value::Null) => default,
            Some(Value::Bool(value)) => value,
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "bool_type",
                    "Input should be a valid boolean",
                    &other,
                ));
                default
            }
        }
    }

    fn bounded_int_or(&mut self, key: &str, default: i64, min: i64, max: i64) -> i64 {
        let value = match self.object.get(key).cloned() {
            None | Some(Value::Null) => return default,
            Some(Value::Number(number)) if number.is_i64() => number.as_i64().unwrap_or(default),
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "int_type",
                    "Input should be a valid integer",
                    &other,
                ));
                return default;
            }
        };
        if value < min {
            self.errors.push(type_error(
                key,
                "greater_than_equal",
                "Input should be greater than or equal to the minimum",
                &json!(value),
            ));
        } else if value > max {
            self.errors.push(type_error(
                key,
                "less_than_equal",
                "Input should be less than or equal to the maximum",
                &json!(value),
            ));
        }
        value
    }

    fn required_enum(&mut self, key: &str, allowed: &[&str]) -> String {
        let message = enum_message(allowed);
        match self.object.get(key).cloned() {
            Some(Value::String(value)) => {
                if allowed.contains(&value.as_str()) {
                    value
                } else {
                    self.errors
                        .push(enum_error(key, &message, &Value::String(value.clone())));
                    value
                }
            }
            None => {
                self.errors.push(missing_error(key));
                String::new()
            }
            Some(other) => {
                self.errors.push(enum_error(key, &message, &other));
                String::new()
            }
        }
    }

    fn enum_or(&mut self, key: &str, default: &str, allowed: &[&str]) -> String {
        let message = enum_message(allowed);
        match self.object.get(key).cloned() {
            None | Some(Value::Null) => default.to_string(),
            Some(Value::String(value)) if allowed.contains(&value.as_str()) => value,
            Some(other) => {
                self.errors.push(enum_error(key, &message, &other));
                default.to_string()
            }
        }
    }

    fn required_object(&mut self, key: &str) -> Value {
        match self.object.get(key).cloned() {
            Some(value @ Value::Object(_)) => value,
            None => {
                self.errors.push(missing_error(key));
                json!({})
            }
            Some(other) => {
                self.errors.push(type_error(
                    key,
                    "dict_type",
                    "Input should be a valid dictionary",
                    &other,
                ));
                json!({})
            }
        }
    }

    /// `Optional[Dict[str, str]]` — `model_ref`.
    fn optional_string_map(&mut self, key: &str) -> Value {
        let Some(raw) = self.object.get(key).cloned() else {
            return Value::Null;
        };
        match raw {
            Value::Null => Value::Null,
            Value::Object(object) => {
                for (name, value) in &object {
                    if !value.is_string() {
                        self.errors.push(loc_error(
                            &["body", key, name],
                            "string_type",
                            "Input should be a valid string",
                            value,
                        ));
                    }
                }
                Value::Object(object)
            }
            other => {
                self.errors.push(type_error(
                    key,
                    "dict_type",
                    "Input should be a valid dictionary",
                    &other,
                ));
                Value::Null
            }
        }
    }

    /// `SubscriptionExecutionTarget` — defaults to `{type: managed, device_id:
    /// null}`; a supplied object keeps only `type`/`device_id`.
    fn execution_target(&mut self) -> Value {
        let default = json!({"type": "managed", "device_id": null});
        let object = match self.object.get("execution_target").cloned() {
            Some(Value::Object(object)) => object,
            None | Some(Value::Null) => return default,
            Some(other) => {
                self.errors.push(type_error(
                    "execution_target",
                    "model_type",
                    "Input should be a valid dictionary",
                    &other,
                ));
                return default;
            }
        };
        let target_type = match object.get("type") {
            None | Some(Value::Null) => "managed".to_string(),
            Some(Value::String(value))
                if ["managed", "local", "cloud", "remote"].contains(&value.as_str()) =>
            {
                value.clone()
            }
            Some(other) => {
                self.errors.push(loc_error(
                    &["body", "execution_target", "type"],
                    "enum",
                    "Input should be 'managed', 'local', 'cloud' or 'remote'",
                    other,
                ));
                "managed".to_string()
            }
        };
        let device_id = match object.get("device_id") {
            None | Some(Value::Null) => Value::Null,
            Some(value @ Value::String(_)) => value.clone(),
            Some(other) => {
                self.errors.push(loc_error(
                    &["body", "execution_target", "device_id"],
                    "string_type",
                    "Input should be a valid string",
                    other,
                ));
                Value::Null
            }
        };
        json!({"type": target_type, "device_id": device_id})
    }

    /// `Optional[List[SubscriptionKnowledgeBaseRef]]` — `{name, namespace}`.
    fn knowledge_base_refs(&mut self, key: &str) -> Value {
        self.ref_list(key, false)
    }

    /// `Optional[List[SubscriptionSkillRef]]` — `{name, namespace, is_public}`.
    fn skill_refs(&mut self, key: &str) -> Value {
        self.ref_list(key, true)
    }

    /// `Optional[List[NotificationWebhook]]` — `{type, url, secret,
    /// enabled}`.
    fn notification_webhooks(&mut self, key: &str) -> Value {
        let Some(raw) = self.object.get(key).cloned() else {
            return Value::Null;
        };
        let Value::Array(entries) = raw else {
            if raw.is_null() {
                return Value::Null;
            }
            self.errors.push(type_error(
                key,
                "list_type",
                "Input should be a valid list",
                &raw,
            ));
            return Value::Null;
        };
        let mut normalized = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let Value::Object(object) = entry else {
                self.errors.push(index_error(
                    key,
                    index,
                    "model_type",
                    "Input should be a valid dictionary",
                    entry,
                ));
                continue;
            };
            let mut kept = Map::new();
            match object.get("type") {
                Some(Value::String(value))
                    if ["dingtalk", "feishu", "custom"].contains(&value.as_str()) =>
                {
                    kept.insert("type".to_string(), Value::String(value.clone()));
                }
                Some(other) => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "type"],
                    "enum",
                    "Input should be 'dingtalk', 'feishu' or 'custom'",
                    other,
                )),
                None => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "type"],
                    "missing",
                    "Field required",
                    &json!(null),
                )),
            }
            match object.get("url") {
                Some(value @ Value::String(_)) => {
                    kept.insert("url".to_string(), value.clone());
                }
                Some(other) => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "url"],
                    "string_type",
                    "Input should be a valid string",
                    other,
                )),
                None => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "url"],
                    "missing",
                    "Field required",
                    &json!(null),
                )),
            }
            let secret = match object.get("secret") {
                Some(value @ Value::String(_)) => value.clone(),
                None | Some(Value::Null) => Value::Null,
                Some(other) => {
                    self.errors.push(loc_error(
                        &["body", key, &index.to_string(), "secret"],
                        "string_type",
                        "Input should be a valid string",
                        other,
                    ));
                    Value::Null
                }
            };
            kept.insert("secret".to_string(), secret);
            let enabled = match object.get("enabled") {
                Some(Value::Bool(value)) => *value,
                None | Some(Value::Null) => true,
                Some(other) => {
                    self.errors.push(loc_error(
                        &["body", key, &index.to_string(), "enabled"],
                        "bool_type",
                        "Input should be a valid boolean",
                        other,
                    ));
                    true
                }
            };
            kept.insert("enabled".to_string(), Value::Bool(enabled));
            normalized.push(Value::Object(kept));
        }
        Value::Array(normalized)
    }

    /// A `List[ref]` where each entry keeps only its declared keys; `skill`
    /// adds the optional `is_public` boolean.
    fn ref_list(&mut self, key: &str, skill: bool) -> Value {
        let Some(raw) = self.object.get(key).cloned() else {
            return Value::Null;
        };
        let Value::Array(entries) = raw else {
            if raw.is_null() {
                return Value::Null;
            }
            self.errors.push(type_error(
                key,
                "list_type",
                "Input should be a valid list",
                &raw,
            ));
            return Value::Null;
        };
        let mut normalized = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let Value::Object(object) = entry else {
                self.errors.push(index_error(
                    key,
                    index,
                    "model_type",
                    "Input should be a valid dictionary",
                    entry,
                ));
                continue;
            };
            let mut kept = Map::new();
            match object.get("name") {
                Some(Value::String(value)) => {
                    kept.insert("name".to_string(), Value::String(value.clone()));
                }
                Some(other) => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "name"],
                    "string_type",
                    "Input should be a valid string",
                    other,
                )),
                None => self.errors.push(loc_error(
                    &["body", key, &index.to_string(), "name"],
                    "missing",
                    "Field required",
                    &json!(null),
                )),
            }
            let namespace = match object.get("namespace") {
                Some(Value::String(value)) => value.clone(),
                None | Some(Value::Null) => "default".to_string(),
                Some(other) => {
                    self.errors.push(loc_error(
                        &["body", key, &index.to_string(), "namespace"],
                        "string_type",
                        "Input should be a valid string",
                        other,
                    ));
                    "default".to_string()
                }
            };
            kept.insert("namespace".to_string(), Value::String(namespace));
            if skill {
                let is_public = match object.get("is_public") {
                    Some(Value::Bool(value)) => *value,
                    None | Some(Value::Null) => false,
                    Some(other) => {
                        self.errors.push(loc_error(
                            &["body", key, &index.to_string(), "is_public"],
                            "bool_type",
                            "Input should be a valid boolean",
                            other,
                        ));
                        false
                    }
                };
                kept.insert("is_public".to_string(), Value::Bool(is_public));
            }
            if kept.contains_key("name") {
                normalized.push(Value::Object(kept));
            }
        }
        Value::Array(normalized)
    }

    fn optional_int_list(&mut self, key: &str) -> Value {
        let Some(raw) = self.object.get(key).cloned() else {
            return Value::Null;
        };
        let Value::Array(entries) = raw else {
            if raw.is_null() {
                return Value::Null;
            }
            self.errors.push(type_error(
                key,
                "list_type",
                "Input should be a valid list",
                &raw,
            ));
            return Value::Null;
        };
        for entry in &entries {
            if !entry.is_i64() {
                self.errors.push(type_error(
                    key,
                    "int_type",
                    "Input should be a valid integer",
                    entry,
                ));
            }
        }
        Value::Array(entries)
    }

    /// `Optional[datetime]` — pydantic accepts ISO 8601; stored as
    /// `datetime.isoformat()`.
    fn optional_datetime(&mut self, key: &str) -> Option<String> {
        let raw = match self.object.get(key) {
            None | Some(Value::Null) => return None,
            Some(Value::String(value)) => value.clone(),
            Some(other) => {
                let other = other.clone();
                self.errors.push(type_error(
                    key,
                    "datetime_type",
                    "Input should be a valid datetime",
                    &other,
                ));
                return None;
            }
        };
        match normalize_datetime(&raw) {
            Some(value) => Some(value),
            None => {
                self.errors.push(type_error(
                    key,
                    "datetime_parsing",
                    "Input should be a valid datetime",
                    &Value::String(raw),
                ));
                None
            }
        }
    }
}

/// Render an ISO-8601 datetime as Python's `datetime.isoformat()`; `None` when
/// the value is not a supported datetime.
fn normalize_datetime(raw: &str) -> Option<String> {
    if let Ok(aware) = chrono::DateTime::parse_from_rfc3339(raw) {
        let offset = aware.offset().to_string();
        let offset = if offset == "Z" {
            "+00:00".to_string()
        } else {
            offset
        };
        return Some(format!(
            "{}{offset}",
            pydantic_datetime(aware.naive_local())
        ));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f"))
        .ok()?;
    Some(pydantic_datetime(naive))
}

/// pydantic's human wording for a closed set of allowed strings.
fn enum_message(allowed: &[&str]) -> String {
    match allowed {
        [only] => format!("Input should be '{only}'"),
        [first, second] => format!("Input should be '{first}' or '{second}'"),
        many => {
            let head = many[..many.len() - 1]
                .iter()
                .map(|value| format!("'{value}'"))
                .collect::<Vec<_>>()
                .join(", ");
            format!("Input should be {head} or '{}'", many[many.len() - 1])
        }
    }
}

fn missing_error(key: &str) -> Value {
    json!({"type": "missing", "loc": ["body", key], "msg": "Field required"})
}

fn type_error(key: &str, kind: &str, message: &str, input: &Value) -> Value {
    loc_error(&["body", key], kind, message, input)
}

fn enum_error(key: &str, message: &str, input: &Value) -> Value {
    json!({"type": "enum", "loc": ["body", key], "msg": message, "input": input})
}

fn index_error(key: &str, index: usize, kind: &str, message: &str, input: &Value) -> Value {
    loc_error(&["body", key, &index.to_string()], kind, message, input)
}

fn loc_error(loc: &[&str], kind: &str, message: &str, input: &Value) -> Value {
    json!({"type": kind, "loc": loc, "msg": message, "input": input})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> Value {
        json!({
            "display_name": "Weather",
            "trigger_type": "cron",
            "trigger_config": {"expression": "0 9 * * *", "timezone": "UTC"},
            "team_id": 42,
            "prompt_template": "say hi",
        })
    }

    #[test]
    fn defaults_are_applied_for_absent_optional_fields() {
        let create = Create::from_value(valid_body()).unwrap();
        assert_eq!(create.name, None);
        assert_eq!(create.task_type, "collection");
        assert_eq!(create.visibility, "private");
        assert_eq!(create.retry_count, 0);
        assert_eq!(create.timeout_seconds, 600);
        assert!(create.enabled);
        assert!(!create.force_override_bot_model);
        assert!(!create.preserve_history);
        assert_eq!(create.history_message_count, 10);
        assert_eq!(create.namespace, "default");
        assert_eq!(
            create.execution_target,
            json!({"type": "managed", "device_id": null})
        );
        assert!(create.knowledge_base_refs.is_null());
        assert!(create.notification_webhooks.is_null());
        assert!(create.skill_refs.is_null());
        assert!(create.market_whitelist_user_ids.is_null());
        assert!(create.expires_at.is_none());
    }

    #[test]
    fn refs_and_target_normalize_in_declaration_order() {
        let create = Create::from_value(json!({
            "display_name": "x",
            "trigger_type": "cron",
            "trigger_config": {},
            "team_id": 1,
            "prompt_template": "p",
            "execution_target": {"type": "cloud", "device_id": "d1"},
            "knowledge_base_refs": [{"name": "kb"}],
            "skill_refs": [{"name": "s"}],
        }))
        .unwrap();
        assert_eq!(
            create.execution_target,
            json!({"type": "cloud", "device_id": "d1"})
        );
        assert_eq!(
            create.knowledge_base_refs,
            json!([{"name": "kb", "namespace": "default"}])
        );
        assert_eq!(
            create.skill_refs,
            json!([{"name": "s", "namespace": "default", "is_public": false}])
        );
    }

    #[test]
    fn missing_required_field_renders_422() {
        let error = Create::from_value(json!({"display_name": "x"})).unwrap_err();
        let entries: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        let entries = entries.as_array().unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry["loc"] == json!(["body", "team_id"]))
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry["type"] == json!("missing"))
        );
    }

    #[test]
    fn bad_enum_range_and_type_render_422() {
        let mut body = valid_body();
        body["trigger_type"] = json!("monthly");
        assert!(Create::from_value(body).is_err());

        let mut body = valid_body();
        body["retry_count"] = json!(9);
        assert!(Create::from_value(body).is_err());

        let mut body = valid_body();
        body["timeout_seconds"] = json!(10);
        assert!(Create::from_value(body).is_err());

        let mut body = valid_body();
        body["execution_target"] = json!({"type": "bad"});
        assert!(Create::from_value(body).is_err());
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let mut body = valid_body();
        body["bogus"] = json!(1);
        assert!(Create::from_value(body).is_ok());
    }

    #[test]
    fn non_object_body_renders_422() {
        assert!(Create::from_value(json!([])).is_err());
    }
}
