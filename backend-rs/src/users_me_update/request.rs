// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/users/me` request decoding: `app.schemas.user.UserUpdate` and the
//! `UserPreferences.model_dump(exclude_unset=True)` document the update path
//! merges.
//!
//! `UserUpdate` ignores unknown keys and treats every field as optional. The
//! merge only applies the preferences a request actually set, so the model's
//! `exclude_unset=True` behaviour is reproduced by keeping the declared fields
//! the request carries, in the models' declaration order, and (for nested
//! models) dropping the nested keys the request omits.
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;
use brz_http_server::StatusCode;

/// The body field names of `UserUpdate`.
const FIELD_USER_NAME: &str = "user_name";
const FIELD_EMAIL: &str = "email";
const FIELD_GIT_INFO: &str = "git_info";
const FIELD_PREFERENCES: &str = "preferences";
const FIELD_CREDENTIAL: &str = "password";

/// `UserUpdate` (`extra="ignore"`): the five updatable fields. Each field is
/// `None` when absent or JSON `null`.
#[derive(Debug, Default)]
pub(super) struct UserUpdate {
    pub(super) user_name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) git_info: Option<Vec<Map<String, Value>>>,
    pub(super) preferences: Option<Map<String, Value>>,
    pub(super) credential: Option<String>,
}

impl UserUpdate {
    /// Decode and validate a `UserUpdate` body. A malformed field renders the
    /// FastAPI request-validation shape (422), which is what happens before the
    /// endpoint's own `try/except`.
    pub(super) fn decode(body: &Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = body else {
            return Err(validation(
                "body",
                "Input should be a valid dictionary or object",
            ));
        };
        Ok(Self {
            user_name: optional_string(object, FIELD_USER_NAME)?,
            email: optional_string(object, FIELD_EMAIL)?,
            git_info: optional_git_info(object)?,
            preferences: optional_preferences(object)?,
            credential: optional_string(object, FIELD_CREDENTIAL)?,
        })
    }

    /// `UserPreferences.model_dump(exclude_unset=True)` for the request's
    /// `preferences` document.
    pub(super) fn preferences_dump(
        &self,
        extension: &dyn crate::user_profile::UserViewExtension,
    ) -> Option<Map<String, Value>> {
        self.preferences
            .as_ref()
            .map(|input| extension.preference_update_dump(input, exclude_unset_dump(input)))
    }
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, FastApiError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(validation(key, "Input should be a valid string")),
    }
}

/// `git_info: Optional[List[GitInfo]]`: every entry must be an object; the
/// per-field validation happens in the merge step, matching `List[GitInfo]`
/// accepting dicts and the service raising on the model's required fields.
fn optional_git_info(
    object: &Map<String, Value>,
) -> Result<Option<Vec<Map<String, Value>>>, FastApiError> {
    match object.get(FIELD_GIT_INFO) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Value::Object(entry) = item else {
                    return Err(validation(FIELD_GIT_INFO, "Input should be a valid list"));
                };
                out.push(entry.clone());
            }
            Ok(Some(out))
        }
        Some(_) => Err(validation(FIELD_GIT_INFO, "Input should be a valid list")),
    }
}

fn optional_preferences(
    object: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, FastApiError> {
    match object.get(FIELD_PREFERENCES) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(document)) => Ok(Some(document.clone())),
        Some(_) => Err(validation(
            FIELD_PREFERENCES,
            "Input should be a valid dictionary or object",
        )),
    }
}

fn validation(field: &str, message: &str) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "detail": [{
                "type": "value_error",
                "loc": ["body", field],
                "msg": message,
                "input": Value::Null,
            }]
        }),
    )
}

/// One `UserPreferences` field and how `exclude_unset` keeps its present keys.
enum Nested {
    /// A scalar or opaque field: the present value is kept unchanged.
    Scalar,
    /// A nested pydantic model (`Model`): keep the declared keys present.
    Model(&'static [&'static str]),
    /// `List[Model]`.
    ListModel(&'static [&'static str]),
    /// `dict[str, Model]`.
    MapModel(&'static [&'static str]),
    /// A model with `extra="allow"` (`MCPProviderKeys`): every key is kept.
    OpenModel,
}

/// `UserPreferences` fields in declaration order with their nested schema.
/// `model_dump` renders fields in that declaration order, which decides the
/// insertion order of any *new* key the merge appends.
const PREFERENCE_FIELDS: &[(&str, Nested)] = &[
    ("employee_id", Nested::Scalar),
    ("send_key", Nested::Scalar),
    ("follow_up_behavior", Nested::Scalar),
    ("search_key", Nested::Scalar),
    ("memory_enabled", Nested::Scalar),
    ("chat_status_items", Nested::Scalar),
    ("tool_output_guard_enabled", Nested::Scalar),
    ("mcp_provider_keys", Nested::OpenModel),
    ("quick_access", Nested::Model(&["version", "teams"])),
    (
        "composer_quick_phrases",
        Nested::ListModel(&[
            "id",
            "title",
            "content",
            "mode",
            "attachmentPaths",
            "createdAt",
        ]),
    ),
    ("default_execution_target", Nested::Scalar),
    (
        "wework_new_chat_model_selection",
        Nested::Model(&["modelName", "modelType", "options"]),
    ),
    ("wework_project_execution_mode", Nested::Scalar),
    (
        "wework_project_work_preferences",
        Nested::MapModel(&["executionMode", "worktreeBranch"]),
    ),
    ("runtime_configs", Nested::MapModel(&["use_user_config"])),
];

/// `UserPreferences.model_dump(exclude_unset=True)`: keep the declared fields
/// present in the request (declaration order) and, for nested models, the
/// nested keys present; unknown top-level keys are dropped like
/// `extra="ignore"` validation.
fn exclude_unset_dump(input: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, schema) in PREFERENCE_FIELDS {
        if let Some(value) = input.get(*name) {
            out.insert((*name).to_string(), filter(schema, value));
        }
    }
    out
}

fn filter(schema: &Nested, value: &Value) -> Value {
    match schema {
        Nested::Scalar | Nested::OpenModel => value.clone(),
        Nested::Model(keys) => filter_model(keys, value),
        Nested::ListModel(keys) => match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| filter_model(keys, item)).collect())
            }
            other => other.clone(),
        },
        Nested::MapModel(keys) => match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), filter_model(keys, item)))
                    .collect(),
            ),
            other => other.clone(),
        },
    }
}

fn filter_model(keys: &[&str], value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let mut out = Map::new();
    for key in keys {
        if let Some(item) = map.get(*key) {
            out.insert((*key).to_string(), item.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exclude_unset_keeps_present_fields_in_declaration_order() {
        let body = json!({
            "preferences": {
                "employee_id": "10001",
                "send_key": "cmd_enter",
                "wework_new_chat_model_selection": {"modelName": "gpt", "modelType": "public"},
                "unknown": true
            }
        });
        let update = UserUpdate::decode(&body).unwrap();
        let dump = update
            .preferences_dump(&crate::user_profile::DefaultUserViewExtension)
            .unwrap();
        let rendered: Vec<&String> = dump.keys().collect();
        assert_eq!(
            rendered,
            vec!["employee_id", "send_key", "wework_new_chat_model_selection"]
        );
        // The nested model keeps only the keys the request set.
        assert_eq!(
            dump["wework_new_chat_model_selection"],
            json!({"modelName": "gpt", "modelType": "public"})
        );
    }

    #[test]
    fn exclude_unset_keeps_open_model_extensions() {
        let body = json!({"preferences": {"mcp_provider_keys": {"bailian": "k", "acme": "v"}}});
        let dump = UserUpdate::decode(&body)
            .unwrap()
            .preferences_dump(&crate::user_profile::DefaultUserViewExtension)
            .unwrap();
        assert_eq!(
            dump["mcp_provider_keys"],
            json!({"bailian": "k", "acme": "v"})
        );
    }

    #[test]
    fn deployment_hook_receives_raw_input_and_filtered_public_dump() {
        struct Extension;
        impl crate::user_profile::UserViewExtension for Extension {
            fn preference_update_dump(
                &self,
                input: &Map<String, Value>,
                mut public_dump: Map<String, Value>,
            ) -> Map<String, Value> {
                assert!(!public_dump.contains_key("custom_preference"));
                public_dump.insert(
                    "custom_preference".into(),
                    input["custom_preference"].clone(),
                );
                public_dump
            }
        }
        let update = UserUpdate::decode(&json!({
            "preferences": {"send_key": "enter", "custom_preference": {"enabled": true}}
        }))
        .unwrap();
        let default_dump = update
            .preferences_dump(&crate::user_profile::DefaultUserViewExtension)
            .unwrap();
        assert_eq!(
            default_dump,
            json!({"send_key": "enter"}).as_object().unwrap().clone()
        );
        let extended = update.preferences_dump(&Extension).unwrap();
        assert_eq!(extended["custom_preference"], json!({"enabled": true}));
    }

    #[test]
    fn null_and_absent_fields_are_none() {
        let update = UserUpdate::decode(&json!({"email": null, "preferences": null})).unwrap();
        assert!(update.email.is_none());
        assert!(update.preferences.is_none());
    }
}
