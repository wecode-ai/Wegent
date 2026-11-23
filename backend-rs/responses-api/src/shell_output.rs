// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shell call output items
//! (`ShellCallOutputItem` / `ShellCallAction` and their builders in
//! `app/services/openapi/output_builder.py`).
//!
//! A shell tool call — from either the `messages_chain` arguments or a
//! `blocks` tool entry's `tool_input` — becomes one `shell_call` item. The
//! `input` passes the parsed arguments dict through unchanged; the `action`
//! re-renders its `commands`/`timeout_ms`/`max_output_length`.
use serde::Serialize;
use serde_json::Value;

use super::output_builder::{OutputItem, ToolOrTextBlock, nonempty_or};

/// The shell call's `input`: the parsed-arguments dict passthrough. The
/// source hands `_parse_arguments(arguments)` (a plain dict) to the
/// response model, so the object keeps the arguments' own keys, order,
/// and number forms — a typed struct cannot express that contract.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ShellInput(serde_json::Map<String, Value>);

impl ShellInput {
    /// The parsed arguments of a chain tool call.
    pub(super) fn from_arguments(arguments: &str) -> Self {
        Self(parse_arguments(arguments))
    }

    /// The block's own `tool_input` object (source `_build_tool_item_from_block`
    /// passes the block's input dict through).
    pub(super) fn from_tool_input(block: &ToolOrTextBlock) -> Self {
        Self(
            block
                .tool_input_json
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        )
    }

    fn commands(&self) -> Vec<String> {
        shell_commands(&self.0)
    }

    fn timeout_ms(&self) -> Option<i64> {
        shell_timeout_ms(&self.0)
    }

    fn max_output_length(&self) -> Option<i64> {
        shell_max_output_length(&self.0)
    }
}

/// `_parse_arguments`: empty input is `{}`; a JSON object parses to itself;
/// everything else (invalid JSON, non-objects) is `{}`. The result is kept
/// as the source's parsed-arguments dict passthrough: arbitrary keys
/// (`working_dir`, …), insertion order, and original number forms.
fn parse_arguments(value: &str) -> serde_json::Map<String, Value> {
    if value.is_empty() {
        return serde_json::Map::new();
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// The shell action's `commands` list: `commands` entries (empty strings
/// dropped), else the single `command`.
fn shell_commands(input: &serde_json::Map<String, Value>) -> Vec<String> {
    if let Some(Value::Array(items)) = input.get("commands") {
        return items
            .iter()
            .filter_map(|item| item.as_str())
            .filter(|command| !command.is_empty())
            .map(str::to_string)
            .collect();
    }
    input
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty())
        .map(|command| vec![command.to_string()])
        .unwrap_or_default()
}

/// The shell action's `timeout_ms`: `timeout_seconds` as int/float,
/// multiplied by 1000.
fn shell_timeout_ms(input: &serde_json::Map<String, Value>) -> Option<i64> {
    let seconds = input.get("timeout_seconds")?;
    if let Some(seconds) = seconds.as_i64() {
        return Some(seconds * 1000);
    }
    seconds.as_f64().map(|seconds| (seconds * 1000.0) as i64)
}

/// The shell action's `max_output_length` (source passes the parsed value
/// through; non-integers are absent in every recorded payload).
fn shell_max_output_length(input: &serde_json::Map<String, Value>) -> Option<i64> {
    match input.get("max_output_length") {
        None | Some(Value::Null) => None,
        Some(value) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value as i64)),
    }
}

/// `ShellCallAction`.
#[derive(Debug, Serialize)]
pub struct ShellCallAction {
    commands: Vec<String>,
    timeout_ms: Option<i64>,
    max_output_length: Option<i64>,
}

/// `ShellCallOutputItem`.
#[derive(Debug, Serialize)]
pub struct ShellCallItem {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    call_id: String,
    status: &'static str,
    action: ShellCallAction,
    name: String,
    input: ShellInput,
}

/// `ShellCallOutputItem` from either the chain arguments or the block's
/// `tool_input`.
pub(super) fn build_shell_item(
    tool_use_id: &str,
    tool_name: &str,
    input: &ShellInput,
    status: &'static str,
) -> OutputItem {
    let commands = input.commands();
    let timeout_ms = input.timeout_ms();
    let max_output_length = input.max_output_length();
    let name = if tool_name.is_empty() {
        "exec"
    } else {
        tool_name
    };
    let id = nonempty_or(tool_use_id, &format!("shell_{name}"));
    OutputItem::ShellCall(ShellCallItem {
        kind: "shell_call",
        id: id.clone(),
        call_id: id,
        status,
        action: ShellCallAction {
            commands,
            timeout_ms,
            max_output_length,
        },
        name: name.to_string(),
        input: input.clone(),
    })
}

/// `_shell_call_status`: `error` -> failed, `pending` -> in_progress,
/// everything else (including no block) -> completed.
pub(super) fn shell_call_status(block: Option<&ToolOrTextBlock>) -> &'static str {
    match block
        .and_then(|block| block.status.as_deref())
        .unwrap_or("")
    {
        "error" => "failed",
        "pending" => "in_progress",
        _ => "completed",
    }
}
