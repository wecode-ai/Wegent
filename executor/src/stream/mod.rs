// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::runner::ExecutionOutcome;

pub fn collect_ndjson_outcome(output: &str) -> ExecutionOutcome {
    let mut text = String::new();
    let mut terminal_outcome = None;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(outcome) = extract_result_outcome(&value) {
            if matches!(outcome, ExecutionOutcome::Cancelled { .. }) {
                return outcome;
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

    terminal_outcome.unwrap_or(ExecutionOutcome::Completed { content: text })
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

fn is_interruption_message(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("interrupted") || value.contains("cancelled") || value.contains("canceled")
}

fn extract_text(value: &Value) -> Option<String> {
    extract_claude_assistant_text(value)
        .or_else(|| extract_claude_text_delta(value))
        .or_else(|| extract_codex_agent_delta(value))
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

fn extract_codex_agent_delta(value: &Value) -> Option<String> {
    (value.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta"))
        .then(|| value.get("params")?.get("delta")?.as_str())
        .flatten()
        .map(ToOwned::to_owned)
}
