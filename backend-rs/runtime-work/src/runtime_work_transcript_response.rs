// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `RuntimeTranscriptResponse` projection for
//! `POST /api/runtime-work/transcript`.
//!
//! Mirrors `app.schemas.runtime_work.RuntimeTranscriptResponse` and
//! `NormalizedRuntimeMessage` pydantic validation: the source model's field
//! order and aliases, its defaults for absent keys, and the `str | int`
//! smart-union scalars. Unknown executor keys are dropped.

use serde::Serialize;
use serde_json::{Map, Value};

/// defaults. Unknown executor keys are dropped by the projection.
#[derive(Debug, Serialize)]
pub(crate) struct RuntimeTranscriptResponse {
    #[serde(rename = "taskId")]
    local_task_id: String,
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    runtime: String,
    title: Option<String>,
    messages: Vec<NormalizedRuntimeMessage>,
    turns: Vec<Value>,
    running: Option<bool>,
    origin: Option<Value>,
    #[serde(rename = "historyUnavailable")]
    history_unavailable: bool,
    #[serde(rename = "turnNavigation")]
    turn_navigation: Vec<Value>,
    #[serde(rename = "contextUsage")]
    context_usage: Option<Value>,
    #[serde(rename = "fullContent")]
    full_content: bool,
    #[serde(rename = "rangeStart")]
    range_start: Option<i64>,
    #[serde(rename = "rangeEnd")]
    range_end: Option<i64>,
    #[serde(rename = "hasMoreBefore")]
    has_more_before: bool,
    #[serde(rename = "beforeCursor")]
    before_cursor: Option<String>,
    #[serde(rename = "hasMoreAfter")]
    has_more_after: bool,
    #[serde(rename = "afterCursor")]
    after_cursor: Option<String>,
    #[serde(rename = "parseError")]
    parse_error: Option<String>,
}

/// `NormalizedRuntimeMessage`: `str | int` unions keep their JSON scalar.
#[derive(Debug, Serialize)]
struct NormalizedRuntimeMessage {
    id: String,
    #[serde(rename = "clientUserMessageId")]
    client_user_message_id: Option<String>,
    #[serde(rename = "turnId")]
    turn_id: Option<String>,
    role: String,
    content: String,
    #[serde(rename = "subtaskId")]
    subtask_id: Option<Value>,
    status: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<Value>,
    source: Option<RuntimeMessageSource>,
    attachments: Vec<Value>,
    blocks: Vec<Value>,
    #[serde(rename = "fileChanges")]
    file_changes: Option<Value>,
}

/// `RuntimeMessageSource`.
#[derive(Debug, Serialize)]
struct RuntimeMessageSource {
    source: String,
    external_id: String,
    channel_type: String,
    channel_id: i64,
    conversation_id: String,
    sender_id: String,
    message_id: Option<String>,
}

impl RuntimeTranscriptResponse {
    /// `RuntimeTranscriptResponse.model_validate(result)`.
    pub(crate) fn from_value(value: &Value) -> Result<Self, ()> {
        let object = value.as_object().ok_or(())?;
        let runtime = required_string(object, "runtime")?;
        if !matches!(runtime.as_str(), "codex" | "claude_code") {
            return Err(());
        }
        let messages = match object.get("messages") {
            None => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(NormalizedRuntimeMessage::from_value)
                .collect::<Result<Vec<_>, ()>>()?,
            Some(_) => return Err(()),
        };
        let turns = object
            .get("turns")
            .and_then(Value::as_array)
            .ok_or(())?
            .iter()
            .map(|turn| turn.as_object().map(|_| turn.clone()).ok_or(()))
            .collect::<Result<Vec<_>, ()>>()?;
        let turn_navigation = optional_object_list(object.get("turnNavigation"))?;
        Ok(Self {
            local_task_id: required_string(object, "taskId")?,
            workspace_path: required_string(object, "workspacePath")?,
            runtime,
            title: optional_string(object.get("title"))?,
            messages,
            turns,
            running: optional_bool(object.get("running"))?,
            origin: optional_object(object.get("origin"))?,
            history_unavailable: boolean_field(object, "historyUnavailable")?,
            turn_navigation,
            context_usage: optional_object(object.get("contextUsage"))?,
            full_content: boolean_field(object, "fullContent")?,
            range_start: optional_integer(object.get("rangeStart"))?,
            range_end: optional_integer(object.get("rangeEnd"))?,
            has_more_before: boolean_field(object, "hasMoreBefore")?,
            before_cursor: optional_string(object.get("beforeCursor"))?,
            has_more_after: boolean_field(object, "hasMoreAfter")?,
            after_cursor: optional_string(object.get("afterCursor"))?,
            parse_error: optional_string(object.get("parseError"))?,
        })
    }
}

impl NormalizedRuntimeMessage {
    fn from_value(value: &Value) -> Result<Self, ()> {
        let object = value.as_object().ok_or(())?;
        let role = required_string(object, "role")?;
        if !matches!(role.as_str(), "user" | "assistant" | "system" | "tool") {
            return Err(());
        }
        Ok(Self {
            id: required_string(object, "id")?,
            client_user_message_id: optional_string(object.get("clientUserMessageId"))?,
            turn_id: optional_string(object.get("turnId"))?,
            role,
            content: match object.get("content") {
                None => String::new(),
                Some(Value::String(content)) => content.clone(),
                Some(_) => return Err(()),
            },
            subtask_id: optional_scalar(object.get("subtaskId"))?,
            status: optional_string(object.get("status"))?,
            created_at: optional_scalar(object.get("createdAt"))?,
            source: match object.get("source") {
                None | Some(Value::Null) => None,
                Some(source) => Some(RuntimeMessageSource::from_value(source)?),
            },
            attachments: optional_object_list(object.get("attachments"))?,
            blocks: optional_object_list(object.get("blocks"))?,
            file_changes: optional_object(object.get("fileChanges"))?,
        })
    }
}

impl RuntimeMessageSource {
    fn from_value(value: &Value) -> Result<Self, ()> {
        let object = value.as_object().ok_or(())?;
        if object.get("source").and_then(Value::as_str) != Some("im") {
            return Err(());
        }
        let channel_id = object.get("channel_id").and_then(Value::as_i64).ok_or(())?;
        Ok(Self {
            source: "im".to_string(),
            external_id: required_string(object, "external_id")?,
            channel_type: required_string(object, "channel_type")?,
            channel_id,
            conversation_id: required_string(object, "conversation_id")?,
            sender_id: required_string(object, "sender_id")?,
            message_id: optional_string(object.get("message_id"))?,
        })
    }
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, ()> {
    match object.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(()),
    }
}

fn optional_string(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(()),
    }
}

fn optional_object(value: Option<&Value>) -> Result<Option<Value>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => Ok(Some(value.clone())),
        Some(_) => Err(()),
    }
}

fn optional_object_list(value: Option<&Value>) -> Result<Vec<Value>, ()> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.is_object().then(|| item.clone()).ok_or(()))
            .collect(),
        Some(_) => Err(()),
    }
}

fn optional_bool(value: Option<&Value>) -> Result<Option<bool>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(()),
    }
}

fn boolean_field(object: &Map<String, Value>, key: &str) -> Result<bool, ()> {
    match object.get(key) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(()),
    }
}

/// `Optional[str | int]` in pydantic smart-union lax mode.
fn optional_scalar(value: Option<&Value>) -> Result<Option<Value>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(_)) => Ok(value.cloned()),
        Some(Value::Bool(value)) => Ok(Some(Value::from(i64::from(*value)))),
        Some(Value::Number(number)) => {
            if let Some(value) = number.as_i64() {
                return Ok(Some(Value::from(value)));
            }
            if let Some(value) = number.as_u64() {
                return Ok(Some(Value::from(value)));
            }
            let value = number.as_f64().ok_or(())?;
            if value.fract() == 0.0 {
                return Ok(Some(Value::from(value as i64)));
            }
            Err(())
        }
        Some(_) => Err(()),
    }
}

/// `Optional[int]`.
fn optional_integer(value: Option<&Value>) -> Result<Option<i64>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            if let Some(value) = number.as_i64() {
                return Ok(Some(value));
            }
            let value = number.as_f64().ok_or(())?;
            if value.fract() == 0.0 {
                Ok(Some(value as i64))
            } else {
                Err(())
            }
        }
        Some(_) => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_projection_applies_model_defaults_and_drops_extras() {
        let value = json!({
            "taskId": "runtime-1",
            "workspacePath": "/work/project",
            "runtime": "codex",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "content": "hi",
                    "runtimeStatus": "done",
                    "subtaskId": 3,
                    "createdAt": "2026-10-21T00:00:00Z",
                }
            ],
            "turns": [{"id": "turn-1"}],
            "success": true,
            "hasMoreAfter": true,
            "afterCursor": "offset:4",
        });
        let response = RuntimeTranscriptResponse::from_value(&value).expect("valid response");
        assert_eq!(response.title, None);
        assert_eq!(response.range_start, None);
        assert!(!response.history_unavailable);
        assert!(!response.full_content);
        assert!(response.turn_navigation.is_empty());
        let message = &response.messages[0];
        assert!(message.attachments.is_empty());
        assert!(message.blocks.is_empty());
        assert!(message.file_changes.is_none());
        assert!(message.source.is_none());
        let serialized = crate::json_contract_tests::serialized(response).unwrap();
        assert_eq!(serialized["taskId"], "runtime-1");
        assert_eq!(serialized["title"], Value::Null);
        assert_eq!(serialized["messages"][0]["subtaskId"], 3);
        assert_eq!(serialized["messages"][0]["attachments"], json!([]));
        assert_eq!(serialized["hasMoreAfter"], true);
        assert!(serialized["messages"][0].get("runtimeStatus").is_none());
    }

    #[test]
    fn response_projection_rejects_invalid_contract_values() {
        let base = json!({
            "taskId": "runtime-1",
            "workspacePath": "/work/project",
            "runtime": "codex",
            "turns": [],
        });
        assert!(RuntimeTranscriptResponse::from_value(&base).is_ok());
        let mut invalid = base.clone();
        invalid["runtime"] = json!("other");
        assert!(RuntimeTranscriptResponse::from_value(&invalid).is_err());
        let mut invalid = base.clone();
        invalid["messages"] = json!([{"id": "m", "role": "human"}]);
        assert!(RuntimeTranscriptResponse::from_value(&invalid).is_err());
        let mut invalid = base;
        invalid["messages"] = json!([{"id": "m", "role": "user", "content": null}]);
        assert!(RuntimeTranscriptResponse::from_value(&invalid).is_err());
    }
}
