// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::{
    agents::interactive_mcp::{
        is_deferred_user_input_result, is_interactive_form_tool, DeferredToolUse,
    },
    runner::ExecutionOutcome,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeStreamSummary {
    pub outcome: ExecutionOutcome,
    pub session_id: Option<String>,
    pub deferred_tool_use: Option<DeferredToolUse>,
    pub stop_reason: Option<String>,
    pub usage: Value,
    pub retryable_api_error: bool,
}

pub fn collect_ndjson_outcome(output: &str) -> ExecutionOutcome {
    collect_claude_stream_summary(output).outcome
}

pub fn collect_claude_stream_summary(output: &str) -> ClaudeStreamSummary {
    let mut text = String::new();
    let mut terminal_outcome = None;
    let mut session_id = None;
    let mut deferred_tool_use = None;
    let mut stop_reason = None;
    let mut usage = Value::Null;
    let mut retryable_api_error = false;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        retryable_api_error |= contains_retryable_api_error(line);
        if let Some(value) = value.get("session_id").and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                session_id = Some(value.to_owned());
            }
        }
        if value.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(reason) = value
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                stop_reason = Some(reason.to_owned());
            }
            if let Some(value) = value.get("usage") {
                usage = value.clone();
            }
            if let Some(tool_use) = extract_deferred_tool_use(&value) {
                deferred_tool_use = Some(tool_use);
            }
        }
        if let Some(outcome) = extract_result_outcome(&value) {
            if matches!(
                outcome,
                ExecutionOutcome::Cancelled { .. } | ExecutionOutcome::WaitingForUserInput { .. }
            ) {
                return ClaudeStreamSummary {
                    outcome,
                    session_id,
                    deferred_tool_use,
                    stop_reason,
                    usage,
                    retryable_api_error,
                };
            }
            terminal_outcome = Some(outcome);
            continue;
        }
        if let Some(error) = extract_error(&value) {
            terminal_outcome.get_or_insert(ExecutionOutcome::Failed { message: error });
            continue;
        }
        if let Some(delta) = extract_text(&value) {
            text.push_str(&delta);
        }
    }

    ClaudeStreamSummary {
        outcome: terminal_outcome.unwrap_or(ExecutionOutcome::Completed { content: text }),
        session_id,
        deferred_tool_use,
        stop_reason,
        usage,
        retryable_api_error,
    }
}

pub fn extract_claude_session_id(output: &str) -> Option<String> {
    let mut session_id = None;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(value) = value.get("session_id").and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                session_id = Some(value.to_owned());
            }
        }
    }
    session_id
}

fn extract_error(value: &Value) -> Option<String> {
    (value.get("type").and_then(Value::as_str) == Some("error"))
        .then(|| value.get("message").and_then(Value::as_str))
        .flatten()
        .map(ToOwned::to_owned)
}

fn extract_result_outcome(value: &Value) -> Option<ExecutionOutcome> {
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    if is_deferred_user_input_result(value) {
        return Some(ExecutionOutcome::WaitingForUserInput {
            stop_reason: result_stop_reason(value),
        });
    }
    if !value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }

    let message = value
        .get("result")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Claude execution failed")
        .to_owned();

    if is_interruption_message(&message)
        || value
            .get("subtype")
            .and_then(Value::as_str)
            .is_some_and(is_interruption_message)
    {
        Some(ExecutionOutcome::Cancelled { message })
    } else {
        Some(ExecutionOutcome::Failed { message })
    }
}

fn result_stop_reason(value: &Value) -> String {
    value
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("tool_deferred")
        .to_owned()
}

fn extract_deferred_tool_use(value: &Value) -> Option<DeferredToolUse> {
    let stop_reason = value.get("stop_reason").and_then(Value::as_str)?;
    if stop_reason != "tool_deferred" && stop_reason != "tool_deferred_unavailable" {
        return None;
    }
    let raw = value
        .get("deferred_tool_use")
        .or_else(|| value.get("deferredToolUse"))?;
    let name = raw.get("name").and_then(Value::as_str)?.to_owned();
    if !is_interactive_form_tool(&name) {
        return None;
    }
    let id = raw
        .get("id")
        .or_else(|| raw.get("tool_use_id"))
        .or_else(|| raw.get("toolUseId"))
        .and_then(Value::as_str)?
        .to_owned();
    let input = raw
        .get("input")
        .or_else(|| raw.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    Some(DeferredToolUse { id, name, input })
}

fn is_interruption_message(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("interrupted") || value.contains("cancelled") || value.contains("canceled")
}

fn contains_retryable_api_error(value: &str) -> bool {
    [
        "API Error: Cannot read properties of undefined",
        "API Error: undefined is not an object",
    ]
    .iter()
    .any(|pattern| value.contains(pattern))
}

pub fn extract_text(value: &Value) -> Option<String> {
    extract_claude_assistant_text(value)
        .or_else(|| extract_claude_text_delta(value))
        .or_else(|| extract_codex_agent_delta(value))
}

pub fn extract_reasoning(value: &Value) -> Option<String> {
    extract_claude_thinking_delta(value)
}

fn extract_claude_assistant_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)?;

    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(block_text) = block.get("text").and_then(Value::as_str) {
                text.push_str(block_text);
            }
        }
    }
    (!text.is_empty()).then_some(text)
}

fn extract_claude_text_delta(value: &Value) -> Option<String> {
    let delta = value.get("delta")?;
    (delta.get("type").and_then(Value::as_str) == Some("text_delta"))
        .then(|| delta.get("text").and_then(Value::as_str))
        .flatten()
        .map(ToOwned::to_owned)
}

fn extract_claude_thinking_delta(value: &Value) -> Option<String> {
    let delta = value.get("delta")?;
    (delta.get("type").and_then(Value::as_str) == Some("thinking_delta"))
        .then(|| delta.get("thinking").and_then(Value::as_str))
        .flatten()
        .map(ToOwned::to_owned)
}

fn extract_codex_agent_delta(value: &Value) -> Option<String> {
    (value.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta"))
        .then(|| value.get("params")?.get("delta")?.as_str())
        .flatten()
        .map(ToOwned::to_owned)
}
