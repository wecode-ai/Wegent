// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses API event parsing for the execution callback.
//!
//! Mirrors `ResponsesAPIEventParser` in
//! `app/services/execution/dispatcher.py`. The source keeps one parser instance
//! (`_event_parser`) for the whole worker process, so its tool-context and
//! reasoning buffers persist across requests; the same process-lifetime state
//! is reproduced here behind a short-lived lock that is never held across an
//! `.await`.
//!
//! The source also collects provider-native video citations from completed
//! knowledge MCP calls (`wecode`-owned). That collection only feeds
//! `result.sources` on `response.completed`, and no recorded callback traffic
//! exercises it, so it is not ported here.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value, json};

use super::event::{EventType, ExecutionEvent};

/// Raised when a Responses API tool event is missing its correlation ID.
#[derive(Debug)]
pub(crate) struct InvalidToolCallEvent(pub String);

#[derive(Default)]
struct ParserState {
    tool_contexts: HashMap<String, Map<String, Value>>,
    reasoning_buffers: HashMap<String, String>,
}

/// Process-lifetime parser mirroring the source `_event_parser` singleton.
#[derive(Default)]
pub(crate) struct ResponsesApiEventParser {
    state: Mutex<ParserState>,
}

/// The shared parser instance (`_event_parser` in source).
pub(crate) fn shared() -> &'static ResponsesApiEventParser {
    static PARSER: std::sync::OnceLock<ResponsesApiEventParser> = std::sync::OnceLock::new();
    PARSER.get_or_init(ResponsesApiEventParser::default)
}

fn request_key(task_id: i64, subtask_id: i64) -> String {
    format!("{task_id}:{subtask_id}")
}

fn tool_key(task_id: i64, subtask_id: i64, tool_use_id: &str) -> String {
    format!("{task_id}:{subtask_id}:{tool_use_id}")
}

fn string_field(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(Value::as_str).map(str::to_string)
}

fn non_empty_tool_use_id(
    value: Option<&Value>,
    context: &str,
) -> Result<String, InvalidToolCallEvent> {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    if text.trim().is_empty() {
        return Err(InvalidToolCallEvent(format!(
            "{context}: missing non-empty tool_use_id"
        )));
    }
    Ok(text)
}

fn json_or_none(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(text).ok()
}

impl ResponsesApiEventParser {
    fn clear_task_contexts(state: &mut ParserState, task_id: i64, subtask_id: i64) {
        let prefix = format!("{task_id}:{subtask_id}:");
        state
            .tool_contexts
            .retain(|key, _| !key.starts_with(&prefix));
        state
            .reasoning_buffers
            .remove(&request_key(task_id, subtask_id));
    }

    /// Parse one OpenAI Responses API event into an internal `ExecutionEvent`.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn parse(
        &self,
        task_id: i64,
        subtask_id: i64,
        message_id: Option<i64>,
        event_type: &str,
        data: &Value,
    ) -> Result<Option<ExecutionEvent>, InvalidToolCallEvent> {
        match event_type {
            "response.created" => {
                let mut start_data = Map::new();
                for key in ["shell_type", "bot_name"] {
                    if let Some(value) = data.get(key)
                        && !value.is_null()
                    {
                        start_data.insert(key.to_string(), value.clone());
                    }
                }
                let mut event = ExecutionEvent::new(EventType::Start, task_id, subtask_id);
                event.data = start_data;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.completed" => {
                let response = data.get("response").cloned().unwrap_or(Value::Null);
                let mut result = extract_completed_result(&response);
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    if let Some(buffered) = state
                        .reasoning_buffers
                        .remove(&request_key(task_id, subtask_id))
                    {
                        let already = result
                            .get("reasoning_content")
                            .map(|value| !value.is_null())
                            .unwrap_or(false);
                        if !already {
                            result.insert("reasoning_content".into(), Value::String(buffered));
                        }
                    }
                    Self::clear_task_contexts(&mut state, task_id, subtask_id);
                }
                let mut event = ExecutionEvent::new(EventType::Done, task_id, subtask_id);
                event.result = Some(Value::Object(result));
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.output_text.delta" => {
                let mut event = ExecutionEvent::new(EventType::Chunk, task_id, subtask_id);
                event.content = string_field(data, "delta").unwrap_or_default();
                event.offset = data.get("offset").and_then(Value::as_i64).unwrap_or(0);
                event.result = data.get("result").cloned();
                let mut extra = Map::new();
                extra.insert(
                    "block_id".into(),
                    data.get("block_id").cloned().unwrap_or(Value::Null),
                );
                extra.insert(
                    "block_offset".into(),
                    data.get("block_offset").cloned().unwrap_or(Value::Null),
                );
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.status.updated" => {
                let phase = data.get("phase").cloned().unwrap_or(Value::Null);
                let context_metrics = match data.get("context_metrics") {
                    Some(Value::Object(_)) => data.get("context_metrics").unwrap().clone(),
                    _ => Value::Object(Map::new()),
                };
                let mut extra = Map::new();
                extra.insert("phase".into(), phase);
                extra.insert("context_metrics".into(), context_metrics);
                extra.insert(
                    "context_compaction".into(),
                    data.get("context_compaction")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                let mut event = ExecutionEvent::new(EventType::StatusUpdated, task_id, subtask_id);
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.block.created" => {
                let Some(block) = data.get("block").filter(|value| value.is_object()) else {
                    return Ok(None);
                };
                let mut extra = Map::new();
                extra.insert("block".into(), block.clone());
                let mut event = ExecutionEvent::new(EventType::BlockCreated, task_id, subtask_id);
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.block.updated" => {
                let Some(block_id) = data.get("block_id").filter(|value| !value.is_null()) else {
                    return Ok(None);
                };
                let Some(updates) = data.get("updates").filter(|value| value.is_object()) else {
                    return Ok(None);
                };
                let mut extra = Map::new();
                extra.insert(
                    "block_id".into(),
                    Value::String(block_id_to_string(block_id)),
                );
                extra.insert("updates".into(), updates.clone());
                let mut event = ExecutionEvent::new(EventType::BlockUpdated, task_id, subtask_id);
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "error" => {
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    Self::clear_task_contexts(&mut state, task_id, subtask_id);
                }
                let mut event = ExecutionEvent::new(EventType::Error, task_id, subtask_id);
                event.error =
                    Some(string_field(data, "message").unwrap_or_else(|| "Unknown error".into()));
                event.error_code = string_field(data, "code");
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.incomplete" => {
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    Self::clear_task_contexts(&mut state, task_id, subtask_id);
                }
                let mut event = ExecutionEvent::new(EventType::Cancelled, task_id, subtask_id);
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.function_call_arguments.delta" => {
                let tool_use_id = non_empty_tool_use_id(
                    data.get("call_id").or_else(|| data.get("item_id")),
                    "function_call_arguments.delta",
                )?;
                let key = tool_key(task_id, subtask_id, &tool_use_id);
                let arguments_summary = data.get("arguments_summary").cloned();
                let mut state = self.state.lock().expect("parser state poisoned");
                let context = state.tool_contexts.entry(key).or_default();
                if let Some(summary) = arguments_summary.as_ref().filter(|value| value.is_object())
                {
                    context.insert("arguments".into(), summary.clone());
                }
                let tool_name = context
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                drop(state);
                let mut event =
                    ExecutionEvent::new(EventType::ToolArgumentDelta, task_id, subtask_id);
                event.tool_name = tool_name;
                event.tool_use_id = Some(tool_use_id);
                event.tool_input = arguments_summary.filter(|value| value.is_object());
                let mut extra = Map::new();
                extra.insert(
                    "tool_protocol".into(),
                    Value::String("function_call".into()),
                );
                extra.insert("argument_status".into(), Value::String("streaming".into()));
                extra.insert(
                    "delta".into(),
                    Value::String(string_field(data, "delta").unwrap_or_default()),
                );
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.function_call_arguments.done" => {
                let tool_use_id = non_empty_tool_use_id(
                    data.get("call_id").or_else(|| data.get("item_id")),
                    "function_call_arguments.done",
                )?;
                let key = tool_key(task_id, subtask_id, &tool_use_id);
                let arguments_str = string_field(data, "arguments").unwrap_or_default();
                let mut tool_input = data.get("arguments_summary").cloned();
                if !tool_input.as_ref().is_some_and(Value::is_object)
                    && let Some(parsed) = json_or_none(&arguments_str)
                {
                    tool_input = Some(parsed);
                }
                let mut state = self.state.lock().expect("parser state poisoned");
                let context = state.tool_contexts.entry(key).or_default();
                if let Some(input) = tool_input.as_ref().filter(|value| value.is_object()) {
                    context.insert("arguments".into(), input.clone());
                }
                let tool_name = context
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let resolved = tool_input
                    .clone()
                    .or_else(|| context.get("arguments").cloned());
                drop(state);
                let mut event =
                    ExecutionEvent::new(EventType::ToolArgumentDone, task_id, subtask_id);
                event.tool_name = tool_name;
                event.tool_use_id = Some(tool_use_id);
                event.tool_input = resolved;
                let mut extra = Map::new();
                extra.insert(
                    "blocks".into(),
                    data.get("blocks").cloned().unwrap_or_else(|| json!([])),
                );
                extra.insert(
                    "tool_protocol".into(),
                    Value::String("function_call".into()),
                );
                extra.insert("argument_status".into(), Value::String("done".into()));
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.reasoning_summary_part.added" | "response.reasoning_summary_text.delta" => {
                let Some(reasoning_content) = reasoning_content(event_type, data) else {
                    return Ok(None);
                };
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    let buffer = state
                        .reasoning_buffers
                        .entry(request_key(task_id, subtask_id))
                        .or_default();
                    buffer.push_str(&reasoning_content);
                }
                let mut event = ExecutionEvent::new(EventType::Thinking, task_id, subtask_id);
                event.content = reasoning_content;
                let mut extra = Map::new();
                extra.insert(
                    "thinking_kind".into(),
                    Value::String("reasoning_summary".into()),
                );
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.output_item.added" => {
                self.parse_output_item_added(task_id, subtask_id, message_id, data)
            }
            "response.mcp_call_arguments.done" => {
                let item_id =
                    non_empty_tool_use_id(data.get("item_id"), "response.mcp_call_arguments.done")?;
                let key = tool_key(task_id, subtask_id, &item_id);
                let arguments_str = string_field(data, "arguments").unwrap_or_default();
                let tool_input = json_or_none(&arguments_str);
                let mut state = self.state.lock().expect("parser state poisoned");
                let Some(context) = state.tool_contexts.get_mut(&key) else {
                    return Ok(None);
                };
                context.insert(
                    "arguments".into(),
                    tool_input.clone().unwrap_or(Value::Null),
                );
                drop(state);
                let mut event = ExecutionEvent::new(EventType::Tool, task_id, subtask_id);
                event.tool_use_id = Some(item_id);
                event.tool_input = tool_input;
                let mut extra = Map::new();
                extra.insert("tool_protocol".into(), Value::String("mcp_call".into()));
                extra.insert("phase".into(), Value::String("arguments_done".into()));
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.mcp_call.completed" | "response.mcp_call.failed" => {
                let item_id = non_empty_tool_use_id(data.get("item_id"), event_type)?;
                let key = tool_key(task_id, subtask_id, &item_id);
                let failure_reason = data.get("failure_reason").cloned();
                let mut state = self.state.lock().expect("parser state poisoned");
                let context = state.tool_contexts.remove(&key).unwrap_or_default();
                drop(state);
                let tool_output = if event_type == "response.mcp_call.failed" {
                    failure_reason.clone().unwrap_or(Value::Null)
                } else {
                    data.get("output").cloned().unwrap_or(Value::Null)
                };
                let tool_name = context
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let server_label = context
                    .get("server_label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let mut event = ExecutionEvent::new(EventType::ToolResult, task_id, subtask_id);
                event.tool_name = tool_name;
                event.tool_use_id = Some(item_id);
                event.tool_input = context
                    .get("arguments")
                    .cloned()
                    .filter(|value| !value.is_null());
                event.tool_output = Some(tool_output);
                let mut extra = Map::new();
                extra.insert("tool_protocol".into(), Value::String("mcp_call".into()));
                extra.insert("server_label".into(), Value::String(server_label));
                extra.insert(
                    "status".into(),
                    Value::String(
                        if event_type == "response.mcp_call.failed" {
                            "failed"
                        } else {
                            "completed"
                        }
                        .into(),
                    ),
                );
                extra.insert("error".into(), failure_reason.unwrap_or(Value::Null));
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            "response.output_item.done" => {
                self.parse_output_item_done(task_id, subtask_id, message_id, data)
            }
            "response.in_progress"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.mcp_call_arguments.delta" => Ok(None),
            _ => Ok(None),
        }
    }
}

fn block_id_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn reasoning_content(event_type: &str, data: &Value) -> Option<String> {
    if event_type == "response.reasoning_summary_text.delta" {
        let delta = data.get("delta");
        return Some(match delta {
            None => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) => String::new(),
            Some(other) => other.to_string(),
        });
    }
    if event_type == "response.reasoning_summary_part.added" {
        let part = data.get("part");
        if let Some(Value::Object(part)) = part
            && part.get("type").and_then(Value::as_str) == Some("reasoning")
        {
            let text = part.get("text");
            return Some(match text {
                None => String::new(),
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) => String::new(),
                Some(other) => other.to_string(),
            });
        }
    }
    None
}

impl ResponsesApiEventParser {
    fn parse_output_item_added(
        &self,
        task_id: i64,
        subtask_id: i64,
        message_id: Option<i64>,
        data: &Value,
    ) -> Result<Option<ExecutionEvent>, InvalidToolCallEvent> {
        let item = data.get("item").cloned().unwrap_or(Value::Null);
        match item.get("type").and_then(Value::as_str) {
            Some("function_call") => {
                let call_id = non_empty_tool_use_id(
                    item.get("call_id").or_else(|| item.get("id")),
                    "response.output_item.added(function_call)",
                )?;
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments_str = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let parsed = json_or_none(arguments_str).unwrap_or_else(|| json!({}));
                let arguments_summary = data.get("arguments_summary").cloned();
                let input = arguments_summary
                    .clone()
                    .filter(|value| value.is_object())
                    .unwrap_or(parsed);
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    let mut context = Map::new();
                    context.insert("protocol".into(), Value::String("function_call".into()));
                    context.insert("name".into(), Value::String(name.clone()));
                    context.insert("arguments".into(), input.clone());
                    state
                        .tool_contexts
                        .insert(tool_key(task_id, subtask_id, &call_id), context);
                }
                let mut event = ExecutionEvent::new(EventType::ToolStart, task_id, subtask_id);
                event.tool_use_id = Some(call_id);
                event.tool_name = Some(name);
                event.tool_input = Some(input);
                let mut extra = Map::new();
                extra.insert(
                    "blocks".into(),
                    data.get("blocks").cloned().unwrap_or_else(|| json!([])),
                );
                extra.insert(
                    "display_name".into(),
                    data.get("display_name").cloned().unwrap_or(Value::Null),
                );
                extra.insert(
                    "tool_protocol".into(),
                    Value::String("function_call".into()),
                );
                extra.insert(
                    "argument_status".into(),
                    data.get("argument_status").cloned().unwrap_or(Value::Null),
                );
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            Some("mcp_call") => {
                let item_id =
                    non_empty_tool_use_id(item.get("id"), "response.output_item.added(mcp_call)")?;
                let server_label = item
                    .get("server_label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    let mut context = Map::new();
                    context.insert("protocol".into(), Value::String("mcp_call".into()));
                    context.insert("name".into(), Value::String(name.clone()));
                    context.insert("server_label".into(), Value::String(server_label.clone()));
                    state
                        .tool_contexts
                        .insert(tool_key(task_id, subtask_id, &item_id), context);
                }
                let mut event = ExecutionEvent::new(EventType::ToolStart, task_id, subtask_id);
                event.tool_use_id = Some(item_id);
                event.tool_name = Some(name);
                let mut extra = Map::new();
                extra.insert("tool_protocol".into(), Value::String("mcp_call".into()));
                extra.insert("server_label".into(), Value::String(server_label));
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            Some("shell_call") => {
                let call_id = non_empty_tool_use_id(
                    item.get("call_id").or_else(|| item.get("id")),
                    "response.output_item.added(shell_call)",
                )?;
                let (name, arguments) = shell_call_context(&item);
                {
                    let mut state = self.state.lock().expect("parser state poisoned");
                    let mut context = Map::new();
                    context.insert("protocol".into(), Value::String("shell_call".into()));
                    context.insert("name".into(), Value::String(name.clone()));
                    context.insert("arguments".into(), arguments.clone());
                    state
                        .tool_contexts
                        .insert(tool_key(task_id, subtask_id, &call_id), context);
                }
                let mut event = ExecutionEvent::new(EventType::ToolStart, task_id, subtask_id);
                event.tool_use_id = Some(call_id);
                event.tool_name = Some(name);
                event.tool_input = Some(arguments);
                let mut extra = Map::new();
                extra.insert(
                    "blocks".into(),
                    data.get("blocks").cloned().unwrap_or_else(|| json!([])),
                );
                extra.insert(
                    "display_name".into(),
                    data.get("display_name").cloned().unwrap_or(Value::Null),
                );
                extra.insert("tool_protocol".into(), Value::String("shell_call".into()));
                event.data = extra;
                event.message_id = message_id;
                Ok(Some(event))
            }
            _ => Ok(None),
        }
    }

    fn parse_output_item_done(
        &self,
        task_id: i64,
        subtask_id: i64,
        message_id: Option<i64>,
        data: &Value,
    ) -> Result<Option<ExecutionEvent>, InvalidToolCallEvent> {
        let item = data.get("item").cloned().unwrap_or(Value::Null);
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if item_type == "function_call" {
            let call_id = non_empty_tool_use_id(
                item.get("call_id").or_else(|| item.get("id")),
                "response.output_item.done(function_call)",
            )?;
            let key = tool_key(task_id, subtask_id, &call_id);
            let context = {
                let mut state = self.state.lock().expect("parser state poisoned");
                state.tool_contexts.remove(&key).unwrap_or_default()
            };
            let arguments_str = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut tool_input = context.get("arguments").cloned();
            if !tool_input.as_ref().is_some_and(Value::is_object)
                && let Some(parsed) = json_or_none(arguments_str)
            {
                tool_input = Some(parsed);
            }
            let mut event = ExecutionEvent::new(EventType::ToolResult, task_id, subtask_id);
            event.tool_name = context
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| item.get("name").and_then(Value::as_str).map(str::to_string));
            event.tool_use_id = Some(call_id);
            event.tool_input = tool_input;
            event.tool_output = item.get("output").cloned();
            let mut extra = Map::new();
            extra.insert(
                "tool_protocol".into(),
                Value::String("function_call".into()),
            );
            extra.insert(
                "status".into(),
                Value::String(
                    item.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_string(),
                ),
            );
            extra.insert(
                "error".into(),
                item.get("error").cloned().unwrap_or(Value::Null),
            );
            event.data = extra;
            event.message_id = message_id;
            return Ok(Some(event));
        }
        if item_type != "shell_call" {
            return Ok(None);
        }
        let call_id = non_empty_tool_use_id(
            item.get("call_id").or_else(|| item.get("id")),
            "response.output_item.done(shell_call)",
        )?;
        let key = tool_key(task_id, subtask_id, &call_id);
        let context = {
            let mut state = self.state.lock().expect("parser state poisoned");
            state.tool_contexts.remove(&key).unwrap_or_default()
        };
        let extracted = shell_call_input(&item);
        let tool_input = if extracted.is_null() {
            context.get("arguments").cloned()
        } else {
            Some(extracted)
        };
        let mut event = ExecutionEvent::new(EventType::ToolResult, task_id, subtask_id);
        event.tool_name = context
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| item.get("name").and_then(Value::as_str).map(str::to_string));
        event.tool_use_id = Some(call_id);
        event.tool_input = tool_input;
        let mut extra = Map::new();
        extra.insert("tool_protocol".into(), Value::String("shell_call".into()));
        extra.insert(
            "status".into(),
            Value::String(
                item.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .to_string(),
            ),
        );
        event.data = extra;
        event.message_id = message_id;
        Ok(Some(event))
    }
}

/// `_build_shell_call_context`: name plus the extracted shell-call input.
fn shell_call_context(item: &Value) -> (String, Value) {
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    (name, shell_call_input(item))
}

/// `_extract_shell_call_input`: merge `input`/`action` into one arguments map.
fn shell_call_input(item: &Value) -> Value {
    let mut result = Map::new();
    if let Some(Value::Object(input)) = item.get("input") {
        for (key, value) in input {
            result.insert(key.clone(), value.clone());
        }
    }
    let Some(Value::Object(action)) = item.get("action") else {
        return Value::Object(result);
    };
    if !result.contains_key("command")
        && let Some(Value::Array(commands)) = action.get("commands")
        && let Some(command) = commands
            .iter()
            .filter_map(Value::as_str)
            .find(|value| !value.trim().is_empty())
    {
        result.insert("command".into(), Value::String(command.to_string()));
    }
    if !result.contains_key("timeout_seconds")
        && let Some(Value::Number(timeout_ms)) = action.get("timeout_ms")
        && let Some(value) = timeout_ms.as_i64()
        && value > 0
    {
        result.insert("timeout_seconds".into(), json!((value + 999) / 1000));
    }
    Value::Object(result)
}

/// `extract_completed_result`: build the DONE result from a `response.completed`
/// payload, preserving the source's field order.
fn extract_completed_result(response: &Value) -> Map<String, Value> {
    let mut value = String::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            let Some(content) = item.get("content").and_then(Value::as_array) else {
                continue;
            };
            for block in content {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.is_empty() {
                    continue;
                }
                match block.get("type").and_then(Value::as_str) {
                    Some("reasoning") => reasoning_parts.push(text.to_string()),
                    None | Some("output_text") | Some("text") => value.push_str(text),
                    _ => {}
                }
            }
        }
    }
    let mut reasoning_content = response.get("reasoning_content").cloned();
    if reasoning_content.as_ref().is_none_or(Value::is_null) && !reasoning_parts.is_empty() {
        reasoning_content = Some(Value::String(reasoning_parts.concat()));
    }
    let mut result = Map::new();
    result.insert("value".into(), Value::String(value));
    for key in [
        "usage",
        "sources",
        "retrieval_summary",
        "blocks",
        "silent_exit",
        "silent_exit_reason",
        "deferred_user_input",
        "deferred_user_input_tool_use_id",
        "loaded_skills",
        "stop_reason",
        "termination_reason",
        "messages_chain",
        "context_metrics",
        "context_compactions",
        "standalone_chat_workspace_path",
        "file_changes",
        "executor_session",
    ] {
        result.insert(
            key.into(),
            response.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    result.insert(
        "reasoning_content".into(),
        reasoning_content.unwrap_or(Value::Null),
    );
    result
}
