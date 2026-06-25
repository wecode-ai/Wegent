// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::runner::ExecutionOutcome;

pub fn collect_ndjson_outcome(output: &str) -> ExecutionOutcome {
    let mut text = String::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(error) = extract_error(&value) {
            return ExecutionOutcome::Failed { message: error };
        }
        if let Some(delta) = extract_text(&value) {
            text.push_str(&delta);
        }
    }

    ExecutionOutcome::Completed { content: text }
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
