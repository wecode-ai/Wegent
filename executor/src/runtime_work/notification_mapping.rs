// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

use base64::{engine::general_purpose, Engine as _};
use serde_json::Value;

use crate::{
    codex_phase::{codex_item_id, codex_phase_name},
    logging::log_executor_event,
};

use super::util::{extract_text, item_type, raw_string_field, reasoning_content, string_field};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TextChunkMapping {
    ProcessDelta {
        process_kind: &'static str,
        block_type: &'static str,
        item_id: Option<String>,
        delta: String,
    },
    ProcessCompleted {
        process_kind: &'static str,
        block_type: &'static str,
        item_id: Option<String>,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolOutputDeltaMapping {
    pub(crate) tool_use_id: String,
    pub(crate) delta: String,
}

pub(crate) fn map_text_chunk(
    method: &str,
    params: &Value,
    _resolved_phase: Option<&str>,
) -> Result<Option<TextChunkMapping>, &'static str> {
    match method {
        "item/reasoning/delta"
        | "item/reasoningSummary/delta"
        | "item/reasoning/summaryTextDelta" => {
            let delta = raw_string_field(params, "delta")
                .or_else(|| string_field(params, "delta"))
                .or_else(|| reasoning_content(params))
                .filter(|delta| !delta.is_empty())
                .ok_or("missing_reasoning_delta")?;
            Ok(Some(TextChunkMapping::ProcessDelta {
                process_kind: "reasoning",
                block_type: "thinking",
                item_id: notification_item_id(params),
                delta,
            }))
        }
        "item/agentMessage/delta" => {
            let delta = raw_string_field(params, "delta")
                .filter(|delta| !delta.is_empty())
                .ok_or("missing_agent_message_delta")?;
            Ok(Some(TextChunkMapping::ProcessDelta {
                process_kind: "assistant_message",
                block_type: "text",
                item_id: notification_item_id(params),
                delta,
            }))
        }
        "item/completed" => {
            let item = params.get("item").unwrap_or(params);
            if item_type(item).as_str() == "reasoning" {
                let text = reasoning_content(item)
                    .filter(|content| !content.is_empty())
                    .ok_or("missing_reasoning_content")?;
                return Ok(Some(TextChunkMapping::ProcessCompleted {
                    process_kind: "reasoning",
                    block_type: "thinking",
                    item_id: notification_item_id(params),
                    text,
                }));
            }
            let Some(text) = completed_assistant_text(params) else {
                return Ok(None);
            };
            Ok(Some(TextChunkMapping::ProcessCompleted {
                process_kind: "assistant_message",
                block_type: "text",
                item_id: notification_item_id(params),
                text,
            }))
        }
        _ => Ok(None),
    }
}

pub(crate) fn map_tool_output_delta(
    method: &str,
    params: &Value,
) -> Result<Option<ToolOutputDeltaMapping>, &'static str> {
    if method != "item/tool/outputDelta"
        && method != "item/commandExecution/outputDelta"
        && method != "process/outputDelta"
        && method != "command/exec/outputDelta"
    {
        return Ok(None);
    }

    let tool_use_id = string_field(params, "call_id")
        .or_else(|| string_field(params, "callId"))
        .or_else(|| string_field(params, "itemId"))
        .or_else(|| string_field(params, "item_id"))
        .or_else(|| string_field(params, "processId"))
        .or_else(|| string_field(params, "process_id"))
        .or_else(|| string_field(params, "processHandle"))
        .or_else(|| string_field(params, "process_handle"))
        .ok_or("missing_tool_output_delta_id")?;
    let delta = raw_string_field(params, "chunk")
        .or_else(|| raw_string_field(params, "delta"))
        .or_else(|| decoded_base64_field(params, "deltaBase64"))
        .or_else(|| decoded_base64_field(params, "delta_base64"))
        .filter(|delta| !delta.is_empty())
        .ok_or("missing_tool_output_delta")?;

    Ok(Some(ToolOutputDeltaMapping { tool_use_id, delta }))
}

pub(crate) fn notification_item_id(params: &Value) -> Option<String> {
    params
        .get("item")
        .and_then(codex_item_id)
        .or_else(|| string_field(params, "itemId"))
        .or_else(|| string_field(params, "item_id"))
        .or_else(|| codex_item_id(params))
}

fn decoded_base64_field(value: &Value, key: &str) -> Option<String> {
    let encoded = raw_string_field(value, key)?;
    let bytes = general_purpose::STANDARD.decode(encoded).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

pub(crate) fn log_dropped_notification(
    local_task_id: &str,
    task_id: &str,
    subtask_id: &str,
    method: &str,
    params: &Value,
    reason: &str,
) {
    log_executor_event(
        "codex runtime notification dropped",
        &[
            ("local_task_id", local_task_id.to_owned()),
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("method", empty_marker(method)),
            ("reason", reason.to_owned()),
            (
                "item_id",
                notification_item_id(params).unwrap_or_else(|| "<none>".to_owned()),
            ),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            (
                "payload_type",
                nested_json_string_field(params, "payload", "type"),
            ),
            (
                "payload_phase",
                nested_json_string_field(params, "payload", "phase"),
            ),
            (
                "payload_channel",
                nested_json_string_field(params, "payload", "channel"),
            ),
        ],
    );
}

pub(crate) fn log_text_mapping(
    local_task_id: &str,
    method: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    text: &str,
) {
    let mut fields = text_mapping_log_fields(
        local_task_id,
        method,
        action,
        resolved_phase,
        params,
        text.len(),
    );
    fields.push(("text_preview", truncate_log_text(text, 160)));
    log_executor_event("codex runtime text mapping", &fields);
}

fn text_mapping_log_fields(
    local_task_id: &str,
    method: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    text_len: usize,
) -> Vec<(&'static str, String)> {
    vec![
        ("local_task_id", local_task_id.to_owned()),
        ("method", method.to_owned()),
        ("action", action.to_owned()),
        (
            "resolved_phase",
            resolved_phase.unwrap_or("<none>").to_owned(),
        ),
        (
            "phase",
            codex_phase_name(params).unwrap_or_else(|| "<none>".to_owned()),
        ),
        (
            "item_id",
            notification_item_id(params).unwrap_or_else(|| "<none>".to_owned()),
        ),
        ("text_len", text_len.to_string()),
    ]
}

pub(crate) fn log_stream_text_mapping(
    local_task_id: &str,
    method: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    text: &str,
) {
    if codex_stream_mapping_debug_enabled() {
        log_text_mapping(local_task_id, method, action, resolved_phase, params, text);
    }
}

pub(crate) fn codex_stream_debug_enabled() -> bool {
    codex_stream_debug_flag().load(Ordering::Relaxed)
}

pub(crate) fn set_codex_stream_debug_enabled(enabled: bool) {
    codex_stream_debug_flag().store(enabled, Ordering::Relaxed);
}

fn codex_stream_debug_flag() -> &'static AtomicBool {
    static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
    ENABLED.get_or_init(|| AtomicBool::new(env_bool("WEGENT_CODEX_STREAM_DEBUG", false)))
}

fn codex_stream_mapping_debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| env_bool("WEGENT_CODEX_STREAM_MAPPING_DEBUG", false))
}

fn env_bool(name: &str, default_value: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default_value,
        })
        .unwrap_or(default_value)
}

fn completed_assistant_text(params: &Value) -> Option<String> {
    let item = params.get("item").unwrap_or(params);
    if !is_assistant_text_item(item) {
        return None;
    }
    extract_text(item).filter(|content| !content.is_empty())
}

fn is_assistant_text_item(item: &Value) -> bool {
    match item_type(item).as_str() {
        "agentmessage" | "agentmessageevent" => true,
        "message" => string_field(item, "role")
            .unwrap_or_default()
            .eq_ignore_ascii_case("assistant"),
        _ => false,
    }
}

fn empty_marker(value: &str) -> String {
    if value.is_empty() {
        "<none>".to_owned()
    } else {
        value.to_owned()
    }
}

fn json_string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn nested_json_string_field(value: &Value, object_key: &str, key: &str) -> String {
    value
        .get(object_key)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn truncate_log_text(text: &str, max_chars: usize) -> String {
    let mut result = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            result.push_str("...");
            return result;
        }
        result.push(ch);
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        codex_stream_debug_enabled, env_bool, map_text_chunk, set_codex_stream_debug_enabled,
        TextChunkMapping,
    };

    #[test]
    fn stream_debug_env_defaults_to_off_for_missing_values() {
        let env_name = format!("WEGENT_TEST_MISSING_STREAM_DEBUG_{}", std::process::id());

        assert!(!env_bool(&env_name, false));
    }

    #[test]
    fn stream_debug_can_be_toggled_at_runtime() {
        set_codex_stream_debug_enabled(true);
        assert!(codex_stream_debug_enabled());

        set_codex_stream_debug_enabled(false);
        assert!(!codex_stream_debug_enabled());
    }

    #[test]
    fn maps_completed_reasoning_summary_to_thinking_block() {
        let mapping = map_text_chunk(
            "item/completed",
            &json!({
                "item": {
                    "id": "reasoning-1",
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "Inspecting logs"},
                        {"type": "summary_text", "text": "Running focused tests"}
                    ]
                }
            }),
            None,
        )
        .expect("reasoning summary should map");

        assert_eq!(
            mapping,
            Some(TextChunkMapping::ProcessCompleted {
                process_kind: "reasoning",
                block_type: "thinking",
                item_id: Some("reasoning-1".to_owned()),
                text: "Inspecting logsRunning focused tests".to_owned(),
            })
        );
    }
}
