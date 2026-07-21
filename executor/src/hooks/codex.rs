// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::PathBuf;

use serde_json::Value;
use thiserror::Error;

use super::model::{HookEventName, PostToolUseInput};

#[derive(Debug, Clone)]
pub struct CodexHookContext {
    pub session_id: String,
    pub turn_id: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub permission_mode: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HookEventError {
    #[error("completed file change item is missing an object payload")]
    InvalidItem,
}

pub fn post_tool_use_from_notification(
    context: &CodexHookContext,
    message: &Value,
) -> Result<Option<PostToolUseInput>, HookEventError> {
    if message.get("method").and_then(Value::as_str) != Some("item/completed") {
        return Ok(None);
    }
    let params = message.get("params").unwrap_or(message);
    let item = params.get("item").unwrap_or(params);
    let item = item.as_object().ok_or(HookEventError::InvalidItem)?;
    let item_type = string(item.get("type"));
    let status = string(item.get("status"));
    if !item_type.is_some_and(|value| value.eq_ignore_ascii_case("fileChange"))
        || !status.is_some_and(|value| value.eq_ignore_ascii_case("completed"))
    {
        return Ok(None);
    }
    let Some(tool_use_id) = string(item.get("id")).map(ToOwned::to_owned) else {
        return Ok(None);
    };
    let agent_id =
        string(params.get("agentId").or_else(|| params.get("agent_id"))).map(ToOwned::to_owned);
    let agent_type =
        string(params.get("agentType").or_else(|| params.get("agent_type"))).map(ToOwned::to_owned);
    let raw_item = Value::Object(item.clone());
    Ok(Some(PostToolUseInput {
        session_id: context.session_id.clone(),
        turn_id: context.turn_id.clone(),
        agent_id,
        agent_type,
        transcript_path: None,
        cwd: context.cwd.clone(),
        hook_event_name: HookEventName::PostToolUse,
        model: context.model.clone(),
        permission_mode: context.permission_mode.clone(),
        tool_name: "apply_patch".to_owned(),
        tool_use_id,
        tool_input: raw_item.clone(),
        tool_response: raw_item,
    }))
}

fn string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn context() -> CodexHookContext {
        CodexHookContext {
            session_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            cwd: PathBuf::from("/workspace"),
            model: Some("gpt-5.5-codex".to_owned()),
            permission_mode: "workspace-write".to_owned(),
        }
    }

    #[test]
    fn maps_completed_file_change_with_canonical_tool_name() {
        let message = json!({"method":"item/completed","params":{"item":{
            "id":"call-1","type":"fileChange","status":"completed","changes":[]
        }}});
        let input = post_tool_use_from_notification(&context(), &message)
            .unwrap()
            .unwrap();
        assert_eq!(input.tool_name, "apply_patch");
        assert_eq!(input.tool_use_id, "call-1");
        assert_eq!(input.session_id, "thread-1");
    }

    #[test]
    fn ignores_failed_missing_id_and_non_file_items() {
        for message in [
            json!({"method":"item/completed","params":{"item":{"id":"1","type":"fileChange","status":"failed"}}}),
            json!({"method":"item/completed","params":{"item":{"type":"fileChange","status":"completed"}}}),
            json!({"method":"item/completed","params":{"item":{"id":"1","type":"commandExecution","status":"completed"}}}),
        ] {
            assert!(post_tool_use_from_notification(&context(), &message)
                .unwrap()
                .is_none());
        }
    }
}
