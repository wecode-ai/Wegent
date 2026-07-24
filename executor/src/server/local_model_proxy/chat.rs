// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses to Chat Completions compatibility for Codex.
//!
//! Codex no longer accepts `wire_api = "chat"`, so providers exposing only
//! Chat Completions must be adapted at the local executor boundary. The event
//! shapes and custom-tool mapping preserve Codex semantics across protocols.

use std::{
    collections::{BTreeMap, HashMap},
    pin::Pin,
};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::logging::log_executor_event;

const CUSTOM_TOOL_INPUT_FIELD: &str = "input";
const CUSTOM_TOOL_INPUT_DESCRIPTION: &str = "Raw string input for the original custom tool. Put only the tool input in this field, preserve every character exactly, and follow the original definition embedded in the function description. Do not add Markdown fences or explanatory text.";
const APPLY_PATCH_OUTPUT_CONTRACT: &str = r#"Critical apply_patch input contract:
- Set the function's `input` field to the patch text itself. JSON escaping is handled by the function-call protocol.
- The first characters must be exactly `*** Begin Patch\n`; put the first file hunk immediately on the next line with no blank line.
- The final marker must be `*** End Patch`, optionally followed by one newline, with no text after it.
- Do not include Markdown code fences, prose, labels, or any characters before `*** Begin Patch` or after `*** End Patch`.
- Follow the embedded Lark grammar exactly.
- For `*** Add File`, every added-file content line must start with `+`, including empty lines (use a line containing only `+`). Never emit raw file contents below an Add File directive.

Valid new-file example (the value of `input`, not a Markdown block):
*** Begin Patch
*** Add File: hello.txt
+first line
+
+third line
*** End Patch

Valid update example:
*** Begin Patch
*** Update File: hello.txt
@@
-old line
+new line
*** End Patch"#;

#[derive(Debug, Clone, PartialEq, Eq)]
enum ToolKind {
    Function,
    Custom,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ToolContext {
    kinds: BTreeMap<String, ToolKind>,
}

impl ToolContext {
    fn insert(&mut self, name: String, kind: ToolKind) {
        self.kinds.entry(name).or_insert(kind);
    }

    fn is_custom(&self, name: &str) -> bool {
        self.kinds.get(name) == Some(&ToolKind::Custom)
    }
}

pub(super) fn responses_to_chat(body: &Value) -> Result<(Value, ToolContext), String> {
    let mut result = Map::new();
    copy_field(body, &mut result, "model", "model");
    let context = build_tool_context(body);
    let mut messages = Vec::new();

    if let Some(instructions) = body.get("instructions") {
        let text = text_value(instructions);
        if !text.is_empty() {
            messages.push(json!({"role": "system", "content": text}));
        }
    }
    if let Some(input) = body.get("input") {
        append_input(input, &context, &mut messages)?;
    }
    result.insert(
        "messages".to_owned(),
        Value::Array(collapse_system_messages(messages)),
    );

    if let Some(max_tokens) = body
        .get("max_output_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .or_else(|| body.get("max_tokens"))
    {
        result.insert("max_tokens".to_owned(), max_tokens.clone());
    }
    for field in [
        "temperature",
        "top_p",
        "stream",
        "parallel_tool_calls",
        "service_tier",
        "stop",
        "user",
    ] {
        copy_field(body, &mut result, field, field);
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        result.insert("stream_options".to_owned(), json!({"include_usage": true}));
    }
    if let Some(effort) = body.pointer("/reasoning/effort") {
        result.insert("reasoning_effort".to_owned(), effort.clone());
    }

    let tools = chat_tools(body, &context);
    if !tools.is_empty() {
        result.insert("tools".to_owned(), Value::Array(tools));
        if let Some(choice) = body.get("tool_choice") {
            if choice != "auto" {
                result.insert("tool_choice".to_owned(), chat_tool_choice(choice));
            }
        }
    }
    Ok((Value::Object(result), context))
}

fn copy_field(body: &Value, result: &mut Map<String, Value>, source: &str, target: &str) {
    if let Some(value) = body.get(source) {
        result.insert(target.to_owned(), value.clone());
    }
}

fn build_tool_context(body: &Value) -> ToolContext {
    let mut context = ToolContext::default();
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        let kind = if tool.get("type").and_then(Value::as_str) == Some("custom") {
            ToolKind::Custom
        } else {
            ToolKind::Function
        };
        context.insert(name.to_owned(), kind);
    }
    context
}

fn chat_tools(body: &Value, context: &ToolContext) -> Vec<Value> {
    body.get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?;
            if context.is_custom(name) {
                let definition = serde_json::to_string(tool).ok()?;
                let contract = if name == "apply_patch" {
                    format!("{APPLY_PATCH_OUTPUT_CONTRACT}\n\n")
                } else {
                    "Put only the custom tool's raw input in the function's `input` field. Do not add Markdown fences or explanatory text.\n\n".to_owned()
                };
                let description =
                    format!("{contract}Original tool definition:\n```json\n{definition}\n```");
                return Some(json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                CUSTOM_TOOL_INPUT_FIELD: {
                                    "type": "string",
                                    "description": CUSTOM_TOOL_INPUT_DESCRIPTION
                                }
                            },
                            "required": [CUSTOM_TOOL_INPUT_FIELD],
                            "additionalProperties": false
                        }
                    }
                }));
            }
            Some(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": tool.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({
                        "type": "object",
                        "properties": {}
                    })),
                    "strict": tool.get("strict").cloned().unwrap_or(Value::Bool(false))
                }
            }))
        })
        .collect()
}

fn responses_tools(tools: &[Value], context: &ToolContext) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                return tool.clone();
            };
            if context.is_custom(name) {
                let contract = if name == "apply_patch" {
                    format!("{APPLY_PATCH_OUTPUT_CONTRACT}\n\n")
                } else {
                    "Put only the custom tool's raw input in the function's `input` field. Do not add Markdown fences or explanatory text.\n\n".to_owned()
                };
                let description = if name == "apply_patch" {
                    contract
                } else {
                    let definition = serde_json::to_string(tool).unwrap_or_default();
                    format!("{contract}Original tool definition:\n```json\n{definition}\n```")
                };
                return json!({
                    "type": "function",
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            CUSTOM_TOOL_INPUT_FIELD: {
                                "type": "string",
                                "description": CUSTOM_TOOL_INPUT_DESCRIPTION
                            }
                        },
                        "required": [CUSTOM_TOOL_INPUT_FIELD],
                        "additionalProperties": false
                    }
                });
            }
            tool.clone()
        })
        .collect()
}

fn responses_tool_choice(choice: &Value) -> Option<Value> {
    let choice_type = choice.get("type").and_then(Value::as_str)?;
    if choice_type == "custom" {
        let mut converted = choice.clone();
        converted["type"] = Value::String("function".to_owned());
        return Some(converted);
    }
    None
}

/// Convert a Codex Responses request into a Responses request where custom
/// tools (such as `apply_patch`) are exposed as standard `function` tools.
/// This lets non-OpenAI / gateway providers that speak the Responses wire
/// protocol see the tool while preserving Codex custom-tool semantics on the
/// way back through [`responses_sse_to_responses`].
pub(super) fn responses_to_responses(body: &Value) -> Result<(Value, ToolContext), String> {
    let mut result = body.clone();
    let context = build_tool_context(&result);

    if let Some(tools) = result.get("tools").and_then(Value::as_array) {
        if !tools.is_empty() {
            result["tools"] = Value::Array(responses_tools(tools, &context));
        }
    }

    if let Some(input) = result.get("input") {
        result["input"] = convert_responses_input_items(input, &context)?;
    }

    if let Some(choice) = result.get("tool_choice") {
        if let Some(converted) = responses_tool_choice(choice) {
            result["tool_choice"] = converted;
        }
    }

    Ok((result, context))
}

fn convert_responses_input_items(input: &Value, context: &ToolContext) -> Result<Value, String> {
    let items = match input {
        Value::Array(items) => items,
        _ => return Ok(input.clone()),
    };

    let mut call_id_to_name: HashMap<String, String> = HashMap::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
            if let (Some(call_id), Some(name)) = (
                item.get("call_id").and_then(Value::as_str),
                item.get("name").and_then(Value::as_str),
            ) {
                call_id_to_name.insert(call_id.to_owned(), name.to_owned());
            }
        }
    }

    let mut converted = Vec::new();
    for item in items {
        converted.push(convert_responses_input_item(
            item,
            context,
            &call_id_to_name,
        )?);
    }
    Ok(Value::Array(converted))
}

fn convert_responses_input_item(
    item: &Value,
    context: &ToolContext,
    call_id_to_name: &HashMap<String, String>,
) -> Result<Value, String> {
    let item_type = item.get("type").and_then(Value::as_str);
    let name = item.get("name").and_then(Value::as_str).unwrap_or_default();

    match item_type {
        Some("custom_tool_call") if context.is_custom(name) => {
            let mut converted = item.clone();
            converted["type"] = Value::String("function_call".to_owned());
            if let Some(input) = converted.get("input").and_then(Value::as_str) {
                let arguments = serde_json::to_string(&json!({CUSTOM_TOOL_INPUT_FIELD: input}))
                    .map_err(|error| error.to_string())?;
                converted["arguments"] = Value::String(arguments);
                converted.as_object_mut().unwrap().remove("input");
            }
            Ok(converted)
        }
        Some("custom_tool_call_output") => {
            let call_id = item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(name) = call_id_to_name.get(call_id) {
                if context.is_custom(name) {
                    let mut converted = item.clone();
                    converted["type"] = Value::String("function_call_output".to_owned());
                    return Ok(converted);
                }
            }
            Ok(item.clone())
        }
        _ => Ok(item.clone()),
    }
}

fn chat_tool_choice(choice: &Value) -> Value {
    if let Some(name) = choice.get("name").and_then(Value::as_str) {
        json!({"type": "function", "function": {"name": name}})
    } else {
        choice.clone()
    }
}

fn append_input(
    input: &Value,
    context: &ToolContext,
    messages: &mut Vec<Value>,
) -> Result<(), String> {
    let items: Vec<&Value> = match input {
        Value::Array(values) => values.iter().collect(),
        other => vec![other],
    };
    let mut pending_calls = Vec::new();
    let mut pending_reasoning = String::new();
    let mut call_names = BTreeMap::new();

    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                append_text(&mut pending_reasoning, &reasoning_text(item));
            }
            Some("function_call") | Some("custom_tool_call") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = if context.is_custom(name)
                    || item.get("type").and_then(Value::as_str) == Some("custom_tool_call")
                {
                    let raw = item
                        .get("input")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    serde_json::to_string(&json!({CUSTOM_TOOL_INPUT_FIELD: raw}))
                        .map_err(|error| error.to_string())?
                } else {
                    json_string(item.get("arguments"))
                };
                call_names.insert(call_id.to_owned(), name.to_owned());
                pending_calls.push(json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments}
                }));
            }
            Some("function_call_output") | Some("custom_tool_call_output") => {
                flush_calls(messages, &mut pending_calls, &mut pending_reasoning);
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let output = item.get("output").map(text_value).unwrap_or_default();
                let output = if call_names.get(call_id).map(String::as_str) == Some("apply_patch") {
                    friendly_apply_patch_output(&output)
                } else {
                    output
                };
                messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
            }
            _ => {
                flush_calls(messages, &mut pending_calls, &mut pending_reasoning);
                if item.is_string() {
                    messages.push(json!({"role": "user", "content": item}));
                } else if item.get("role").is_some() || item.get("content").is_some() {
                    let role = match item.get("role").and_then(Value::as_str) {
                        Some("developer") | Some("system") => "system",
                        Some("assistant") => "assistant",
                        _ => "user",
                    };
                    let mut message = json!({
                        "role": role,
                        "content": chat_content(item.get("content").unwrap_or(&Value::Null))
                    });
                    if role == "assistant" && !pending_reasoning.is_empty() {
                        message["reasoning_content"] =
                            Value::String(std::mem::take(&mut pending_reasoning));
                    }
                    messages.push(message);
                }
            }
        }
    }
    flush_calls(messages, &mut pending_calls, &mut pending_reasoning);
    Ok(())
}

pub(super) fn friendly_apply_patch_output(output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    if !lower.contains("apply_patch")
        || !(lower.contains("failed")
            || lower.contains("error")
            || lower.contains("invalid")
            || lower.contains("could not"))
    {
        return output.to_owned();
    }

    let diagnosis = if lower.contains("invalid hunk") || lower.contains("hunk header") {
        "The patch contains an invalid hunk. After `*** Update File`, start a hunk with `@@` (optionally followed by context text), then prefix unchanged lines with one space, removed lines with `-`, and added lines with `+`."
    } else if lower.contains("add file") {
        "For `*** Add File`, every file-content line must start with `+`, including blank lines (write a line containing only `+`)."
    } else if lower.contains("begin patch") || lower.contains("end patch") {
        "The input must start with `*** Begin Patch`, end with `*** End Patch`, and contain no Markdown fence or prose outside those markers."
    } else if lower.contains("context") || lower.contains("does not match") {
        "The update context did not match the current file. Read the relevant file section again and build a smaller hunk using the exact current lines."
    } else {
        "Use the exact apply_patch grammar and correct the specific error reported above."
    };

    format!(
        "{output}\n\nThe patch was not applied. {diagnosis}\n\nCorrect update example:\n*** Begin Patch\n*** Update File: path/to/file.txt\n@@\n-old line\n+new line\n*** End Patch\n\nCorrect new-file example:\n*** Begin Patch\n*** Add File: path/to/new-file.txt\n+first line\n+\n+third line\n*** End Patch\n\nFix the reported error and call `apply_patch` again. Do not switch to shell redirection, `cat`, Python, or another file-writing workaround."
    )
}

fn flush_calls(messages: &mut Vec<Value>, calls: &mut Vec<Value>, reasoning: &mut String) {
    if calls.is_empty() {
        return;
    }
    let mut message = json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": std::mem::take(calls)
    });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(std::mem::take(reasoning));
    }
    messages.push(message);
}

fn chat_content(content: &Value) -> Value {
    match content {
        Value::String(_) => content.clone(),
        Value::Array(parts) => {
            let converted = parts
                .iter()
                .filter_map(|part| {
                    match part.get("type").and_then(Value::as_str) {
                    Some("input_text") | Some("output_text") | Some("text") => Some(json!({
                        "type": "text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or_default()
                    })),
                    Some("input_image") => part.get("image_url").map(|url| json!({
                        "type": "image_url",
                        "image_url": if url.is_string() { json!({"url": url}) } else { url.clone() }
                    })),
                    _ => None,
                }
                })
                .collect::<Vec<_>>();
            if converted.len() == 1 && converted[0].get("type") == Some(&json!("text")) {
                converted[0].get("text").cloned().unwrap_or(Value::Null)
            } else {
                Value::Array(converted)
            }
        }
        _ => Value::Null,
    }
}

fn collapse_system_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut system = Vec::new();
    let mut rest = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            let text = text_value(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                system.push(text);
            }
        } else {
            rest.push(message);
        }
    }
    if system.is_empty() {
        rest
    } else {
        let mut result = vec![json!({"role": "system", "content": system.join("\n\n")})];
        result.extend(rest);
        result
    }
}

fn reasoning_text(item: &Value) -> String {
    item.get("summary")
        .or_else(|| item.get("content"))
        .map(text_value)
        .unwrap_or_default()
}

fn text_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(text_value)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .map(text_value)
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn json_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned()),
        None => "{}".to_owned(),
    }
}

fn append_text(target: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push_str("\n\n");
    }
    target.push_str(value);
}

#[derive(Debug, Default)]
struct TextState {
    started: bool,
    text: String,
    output_index: u32,
    item_id: String,
}

#[derive(Debug, Default)]
struct ReasoningState {
    started: bool,
    text: String,
    output_index: u32,
    item_id: String,
}

#[derive(Debug, Default)]
struct CallState {
    started: bool,
    output_index: u32,
    item_id: String,
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug)]
struct ChatStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    output: std::collections::VecDeque<Result<Bytes, std::io::Error>>,
    context: ToolContext,
    response_started: bool,
    completed: bool,
    response_id: String,
    model: String,
    created_at: u64,
    next_output_index: u32,
    text: TextState,
    reasoning: ReasoningState,
    calls: BTreeMap<usize, CallState>,
    usage: Value,
    finish_reason: Option<String>,
    saw_done: bool,
    saw_choice: bool,
}

/// State kept while rewriting a Responses API stream so that function-call
/// events for originally-custom tools are presented to Codex as
/// `custom_tool_call` events again.
struct ResponsesCustomToolState {
    context: ToolContext,
    calls: HashMap<String, CustomToolCallAccumulatingState>,
}

#[derive(Default)]
struct CustomToolCallAccumulatingState {
    name: String,
    arguments: String,
    done: bool,
}

impl ResponsesCustomToolState {
    fn is_custom_item(&self, item: &Value) -> Option<String> {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return None;
        }
        let name = item.get("name").and_then(Value::as_str)?;
        if !self.context.is_custom(name) {
            return None;
        }
        Some(name.to_owned())
    }

    fn start_call(&mut self, item_id: &str, name: &str) {
        self.calls.entry(item_id.to_owned()).or_default().name = name.to_owned();
    }

    fn append_arguments(&mut self, item_id: &str, delta: &str) {
        if let Some(state) = self.calls.get_mut(item_id) {
            state.arguments.push_str(delta);
        }
    }

    fn finish_arguments(&mut self, item_id: &str, arguments: Option<&str>) -> Option<String> {
        let state = self.calls.get_mut(item_id)?;
        if let Some(arguments) = arguments {
            state.arguments = arguments.to_owned();
        }
        state.done = true;
        extract_custom_tool_input(&state.name, &state.arguments)
    }

    fn snapshot_input(&self, item_id: &str) -> Option<String> {
        let state = self.calls.get(item_id)?;
        if state.arguments.is_empty() {
            return None;
        }
        extract_custom_tool_input(&state.name, &state.arguments)
    }
}

fn extract_custom_tool_input(_name: &str, arguments: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        if let Some(input) = value.get(CUSTOM_TOOL_INPUT_FIELD).cloned() {
            return match input {
                Value::String(text) => Some(text),
                other => serde_json::to_string(&other).ok(),
            };
        }
    }
    Some(arguments.to_owned())
}

fn function_call_item_to_custom(item: &mut Value, input: Option<&str>) {
    item["type"] = Value::String("custom_tool_call".to_owned());
    let input = input.map(|value| value.to_owned()).or_else(|| {
        item.get("arguments")
            .and_then(Value::as_str)
            .and_then(|arguments| extract_custom_tool_input("", arguments))
    });
    if let Some(input) = input {
        item["input"] = Value::String(input);
    }
    if let Some(object) = item.as_object_mut() {
        object.remove("arguments");
    }
}

/// Transform a Responses API SSE stream so that `function_call` events for
/// tools that were originally `type: "custom"` are turned back into
/// `custom_tool_call` events Codex understands.
pub(super) fn responses_sse_to_responses<S, E>(
    stream: S,
    context: ToolContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    use std::collections::VecDeque;

    let state = ResponsesStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        output: VecDeque::new(),
        context_state: ResponsesCustomToolState {
            context,
            calls: HashMap::new(),
        },
        source_done: false,
        terminal_seen: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            if state.terminal_seen {
                return None;
            }
            if state.source_done {
                state.terminal_seen = true;
                return Some((
                    Ok(super::responses_failed_event(
                        "Upstream Responses stream ended before a terminal event",
                    )),
                    state,
                ));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(block) = super::take_sse_block(&mut state.pending) {
                        if super::is_responses_terminal_event(&block) {
                            state.terminal_seen = true;
                        }
                        let rewritten =
                            rewrite_responses_sse_block(&block, &mut state.context_state);
                        if let Some(rewritten) = rewritten {
                            if !rewritten.is_empty() {
                                state
                                    .output
                                    .push_back(Ok(Bytes::from(format!("{}\n\n", rewritten))));
                            }
                        } else {
                            state
                                .output
                                .push_back(Ok(Bytes::from(format!("{}\n\n", block))));
                        }
                    }
                }
                Some(Err(error)) => {
                    state.source_done = true;
                    state.terminal_seen = true;
                    return Some((Ok(super::responses_failed_event(&error.to_string())), state));
                }
                None => {
                    state.source_done = true;
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        if super::is_responses_terminal_event(trailing) {
                            state.terminal_seen = true;
                        }
                        let rewritten =
                            rewrite_responses_sse_block(trailing, &mut state.context_state);
                        if let Some(rewritten) = rewritten {
                            if !rewritten.is_empty() {
                                state
                                    .output
                                    .push_back(Ok(Bytes::from(format!("{}\n\n", rewritten))));
                            }
                        } else {
                            state
                                .output
                                .push_back(Ok(Bytes::from(format!("{}\n\n", trailing))));
                        }
                    }
                }
            }
        }
    })
}

struct ResponsesStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    output: std::collections::VecDeque<Result<Bytes, std::io::Error>>,
    context_state: ResponsesCustomToolState,
    source_done: bool,
    terminal_seen: bool,
}

fn rewrite_responses_sse_block(
    block: &str,
    state: &mut ResponsesCustomToolState,
) -> Option<String> {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for raw_line in block.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim_start();
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    let data = data_lines.join("\n");
    let data = data.trim();
    let mut value = serde_json::from_str::<Value>(data).ok()?;

    let rewritten = match event_name.as_deref() {
        Some("response.output_item.added") => {
            if let Some(item) = value.get_mut("item") {
                if let Some(name) = state.is_custom_item(item) {
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    state.start_call(&item_id, &name);
                    function_call_item_to_custom(item, None);
                }
            }
            rewrite_event_data(block, &value)
        }
        Some("response.function_call_arguments.delta") => {
            let item_id = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                state.append_arguments(&item_id, delta);
            }
            if state.calls.contains_key(&item_id) {
                // Swallow the original delta; we'll emit the full input on done.
                return Some(String::new());
            }
            None
        }
        Some("response.function_call_arguments.done") => {
            let item_id = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let arguments = value.get("arguments").and_then(Value::as_str);
            if let Some(input) = state.finish_arguments(&item_id, arguments) {
                let output_index = value.get("output_index").cloned().unwrap_or(Value::Null);
                let mut events = String::new();
                events.push_str(&format_sse_event(
                    "response.custom_tool_call_input.delta",
                    &json!({
                        "type": "response.custom_tool_call_input.delta",
                        "item_id": item_id,
                        "output_index": output_index,
                        "delta": input,
                    }),
                ));
                events.push_str(&format_sse_event(
                    "response.custom_tool_call_input.done",
                    &json!({
                        "type": "response.custom_tool_call_input.done",
                        "item_id": item_id,
                        "output_index": output_index,
                        "input": input,
                    }),
                ));
                return Some(events);
            }
            None
        }
        Some("response.output_item.done") => {
            if let Some(item) = value.get_mut("item") {
                if state.is_custom_item(item).is_some() {
                    let input = item
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(|item_id| state.snapshot_input(item_id));
                    function_call_item_to_custom(item, input.as_deref());
                }
            }
            rewrite_event_data(block, &value)
        }
        Some("response.completed") => {
            if let Some(response) = value.get_mut("response") {
                if let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) {
                    for item in output {
                        if state.is_custom_item(item).is_some() {
                            let input = item
                                .get("id")
                                .and_then(Value::as_str)
                                .and_then(|item_id| state.snapshot_input(item_id));
                            function_call_item_to_custom(item, input.as_deref());
                        }
                    }
                }
            }
            rewrite_event_data(block, &value)
        }
        _ => None,
    };

    rewritten.or_else(|| Some(block.to_owned()))
}

fn format_sse_event(event: &str, data: &Value) -> String {
    format!(
        "event: {}\ndata: {}\n\n",
        event,
        serde_json::to_string(data).unwrap_or_default()
    )
}

fn rewrite_event_data(block: &str, value: &Value) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for raw_line in block.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim_start();
        if let Some(data) = line.strip_prefix("data:") {
            if !replaced {
                lines.push(format!(
                    "data: {}",
                    serde_json::to_string(value).unwrap_or_else(|_| data.trim_start().to_owned())
                ));
                replaced = true;
                continue;
            }
        }
        lines.push(raw_line.to_owned());
    }
    Some(lines.join("\n"))
}

pub(super) fn chat_sse_to_responses<S, E>(
    stream: S,
    context: ToolContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    let state = ChatStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        output: std::collections::VecDeque::new(),
        context,
        response_started: false,
        completed: false,
        response_id: "resp_wework_chat".to_owned(),
        model: String::new(),
        created_at: 0,
        next_output_index: 0,
        text: TextState::default(),
        reasoning: ReasoningState::default(),
        calls: BTreeMap::new(),
        usage: responses_usage(None),
        finish_reason: None,
        saw_done: false,
        saw_choice: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(block) = super::take_sse_block(&mut state.pending) {
                        state.handle_block(&block, true);
                    }
                }
                Some(Err(error)) => {
                    let event = state.failed_event(error.to_string());
                    state.completed = true;
                    return Some((Ok(event), state));
                }
                None => {
                    if state.completed {
                        return None;
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        state.handle_block(&trailing, false);
                    }
                    if state.response_started && state.finish_reason.is_none() && !state.saw_done {
                        let event = state.failed_event(
                            "Upstream stream ended before a finish reason or [DONE] marker"
                                .to_owned(),
                        );
                        state.completed = true;
                        state.emit(event);
                    } else {
                        state.finish();
                    }
                    if let Some(output) = state.output.pop_front() {
                        return Some((output, state));
                    }
                    return None;
                }
            }
        }
    })
}

impl<S> ChatStreamState<S> {
    fn emit(&mut self, event: Bytes) {
        self.output.push_back(Ok(event));
    }

    fn handle_block(&mut self, block: &str, strict: bool) {
        let mut event_name = None;
        let mut data_lines = Vec::new();
        for raw_line in block.lines() {
            let line = raw_line.trim_start_matches('\u{feff}').trim_start();
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start());
            }
        }
        if data_lines.is_empty() {
            return;
        }
        let data = data_lines.join("\n");
        let data = data.trim();
        if data == "[DONE]" {
            self.saw_done = true;
            self.finish();
            return;
        }
        let chunk = match serde_json::from_str::<Value>(data) {
            Ok(chunk) => chunk,
            Err(_) if !strict => return,
            Err(error) => {
                self.emit(
                    self.failed_event(format!("Failed to parse upstream SSE chunk: {error}")),
                );
                self.completed = true;
                return;
            }
        };
        if event_name.is_some_and(|value| value.eq_ignore_ascii_case("error")) {
            let message = meaningful_error_message(chunk.get("error").unwrap_or(&chunk))
                .unwrap_or_else(|| "upstream error event in SSE stream".to_owned());
            self.emit(self.failed_event(message));
            self.completed = true;
            return;
        }
        if let Some(message) = chunk.get("error").and_then(meaningful_error_message) {
            self.emit(self.failed_event(message));
            self.completed = true;
            return;
        }
        self.handle_chunk(&chunk);
    }

    fn handle_chunk(&mut self, chunk: &Value) {
        if let Some(id) = chunk.get("id").and_then(Value::as_str) {
            self.response_id = format!("resp_{}", id.trim_start_matches("chatcmpl-"));
        }
        if let Some(model) = chunk.get("model").and_then(Value::as_str) {
            self.model = model.to_owned();
        }
        if let Some(created) = chunk.get("created").and_then(Value::as_u64) {
            self.created_at = created;
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            self.usage = responses_usage(Some(usage));
        }
        self.ensure_started();

        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| {
                choices
                    .iter()
                    .find(|choice| choice.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
            })
        else {
            return;
        };
        self.saw_choice = true;
        let delta_nonempty = choice
            .get("delta")
            .and_then(Value::as_object)
            .is_some_and(|value| !value.is_empty());
        let (payload, is_snapshot) = if delta_nonempty {
            (choice.get("delta"), false)
        } else if choice.get("message").is_some() {
            (choice.get("message"), true)
        } else {
            (choice.get("delta"), false)
        };
        if let Some(payload) = payload {
            if let Some(reasoning) = reasoning_delta(payload) {
                let delta = if is_snapshot {
                    snapshot_suffix(&self.reasoning.text, &reasoning).to_owned()
                } else {
                    reasoning
                };
                self.push_reasoning(&delta);
            }
            if let Some(content) = content_delta(payload) {
                let delta = if is_snapshot {
                    snapshot_suffix(&self.text.text, &content).to_owned()
                } else {
                    content
                };
                self.push_text(&delta);
            }
            if let Some(calls) = payload.get("tool_calls").and_then(Value::as_array) {
                for (position, call) in calls.iter().enumerate() {
                    self.push_call(call, position, is_snapshot);
                }
            } else if let Some(function_call) = payload.get("function_call") {
                self.push_call(
                    &json!({
                        "index": 0,
                        "id": function_call.get("id").cloned().unwrap_or(Value::Null),
                        "function": function_call
                    }),
                    0,
                    is_snapshot,
                );
            }
        }
        if self.finish_reason.is_none() {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_owned());
            }
        }
    }

    fn ensure_started(&mut self) {
        if self.response_started {
            return;
        }
        self.response_started = true;
        let response = self.response("in_progress", Vec::new());
        self.emit(sse(
            "response.created",
            json!({"type": "response.created", "response": response}),
        ));
        self.emit(sse(
            "response.in_progress",
            json!({"type": "response.in_progress", "response": response}),
        ));
    }

    fn next_index(&mut self) -> u32 {
        let result = self.next_output_index;
        self.next_output_index += 1;
        result
    }

    fn push_reasoning(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if !self.reasoning.started {
            let output_index = self.next_index();
            let item_id = format!("rs_{}", self.response_id);
            self.reasoning.started = true;
            self.reasoning.output_index = output_index;
            self.reasoning.item_id = item_id.clone();
            let item =
                json!({"id": item_id, "type": "reasoning", "status": "in_progress", "summary": []});
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
            self.emit(sse("response.reasoning_summary_part.added", json!({"type": "response.reasoning_summary_part.added", "item_id": item_id, "output_index": output_index, "summary_index": 0, "part": {"type": "summary_text", "text": ""}})));
        }
        self.reasoning.text.push_str(delta);
        self.emit(sse("response.reasoning_summary_text.delta", json!({"type": "response.reasoning_summary_text.delta", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "delta": delta})));
    }

    fn push_text(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if !self.text.started {
            let output_index = self.next_index();
            let item_id = format!("{}_msg", self.response_id);
            self.text.started = true;
            self.text.output_index = output_index;
            self.text.item_id = item_id.clone();
            let item = json!({"id": item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []});
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
            self.emit(sse("response.content_part.added", json!({"type": "response.content_part.added", "item_id": item_id, "output_index": output_index, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})));
        }
        self.text.text.push_str(delta);
        self.emit(sse("response.output_text.delta", json!({"type": "response.output_text.delta", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "delta": delta})));
    }

    fn push_call(&mut self, call: &Value, fallback_index: usize, is_snapshot: bool) {
        let index = call
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(fallback_index);
        let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
        let function = call.get("function").unwrap_or(&Value::Null);
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = match function.get("arguments") {
            Some(Value::String(value)) => value.clone(),
            Some(value) if !value.is_null() => {
                serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
            }
            _ => String::new(),
        };
        let (needs_start, call_id, complete_name) = {
            let state = self.calls.entry(index).or_default();
            if !id.is_empty() {
                state.call_id = id.to_owned();
            }
            if !name.is_empty() {
                state.name = name.to_owned();
            }
            if !arguments.is_empty() {
                if is_snapshot {
                    state.arguments = arguments.clone();
                } else {
                    state.arguments.push_str(&arguments);
                }
            }
            (
                !state.started && !state.name.is_empty(),
                state.call_id.clone(),
                state.name.clone(),
            )
        };
        if needs_start {
            let output_index = self.next_index();
            let call_id = if call_id.is_empty() {
                format!("call_{index}")
            } else {
                call_id
            };
            let item_id = format!("fc_{}", call_id.trim_start_matches("call_"));
            let state = self.calls.entry(index).or_default();
            state.started = true;
            state.output_index = output_index;
            state.item_id = item_id.clone();
            state.call_id = call_id.clone();
            let item_type = if self.context.is_custom(&complete_name) {
                "custom_tool_call"
            } else {
                "function_call"
            };
            let item = if item_type == "custom_tool_call" {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name, "input": ""})
            } else {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name, "arguments": ""})
            };
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
        }
        if !arguments.is_empty() {
            let (output_index, item_id, custom) = {
                let state = self.calls.entry(index).or_default();
                (
                    state.output_index,
                    state.item_id.clone(),
                    self.context.is_custom(&state.name),
                )
            };
            if !custom && !item_id.is_empty() {
                let event = "response.function_call_arguments.delta";
                self.emit(sse(event, json!({"type": event, "item_id": item_id, "output_index": output_index, "delta": arguments})));
            }
        }
    }

    fn finish(&mut self) {
        if self.completed {
            return;
        }
        if !self.saw_choice {
            self.completed = true;
            self.emit(
                self.failed_event("Upstream stream ended without a completion choice".to_owned()),
            );
            return;
        }
        self.ensure_started();
        self.completed = true;
        let mut output = Vec::new();
        if self.reasoning.started {
            let item = json!({"id": self.reasoning.item_id, "type": "reasoning", "status": "completed", "summary": [{"type": "summary_text", "text": self.reasoning.text}]});
            self.emit(sse("response.reasoning_summary_text.done", json!({"type": "response.reasoning_summary_text.done", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "text": self.reasoning.text})));
            self.emit(sse("response.reasoning_summary_part.done", json!({"type": "response.reasoning_summary_part.done", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "part": {"type": "summary_text", "text": self.reasoning.text}})));
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": self.reasoning.output_index, "item": item})));
            output.push((self.reasoning.output_index, item));
        }
        if self.text.started {
            let part = json!({"type": "output_text", "text": self.text.text, "annotations": []});
            let item = json!({"id": self.text.item_id, "type": "message", "status": "completed", "role": "assistant", "content": [part]});
            self.emit(sse("response.output_text.done", json!({"type": "response.output_text.done", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "text": self.text.text})));
            self.emit(sse("response.content_part.done", json!({"type": "response.content_part.done", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "part": part})));
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": self.text.output_index, "item": item})));
            output.push((self.text.output_index, item));
        }
        let calls = std::mem::take(&mut self.calls);
        for (_, state) in calls {
            if !state.started {
                continue;
            }
            let custom = self.context.is_custom(&state.name);
            let arguments = if custom {
                custom_input(&state.name, &state.arguments)
            } else {
                normalize_arguments(&state.arguments)
            };
            let item = if custom {
                json!({"id": state.item_id, "type": "custom_tool_call", "status": "completed", "call_id": state.call_id, "name": state.name, "input": arguments})
            } else {
                json!({"id": state.item_id, "type": "function_call", "status": "completed", "call_id": state.call_id, "name": state.name, "arguments": arguments})
            };
            let done_event = if custom {
                "response.custom_tool_call_input.done"
            } else {
                "response.function_call_arguments.done"
            };
            if custom && !arguments.is_empty() {
                let delta_event = "response.custom_tool_call_input.delta";
                self.emit(sse(
                    delta_event,
                    json!({
                        "type": delta_event,
                        "item_id": state.item_id,
                        "output_index": state.output_index,
                        "delta": arguments
                    }),
                ));
            }
            let done_payload = if custom {
                json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "input": arguments})
            } else {
                json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "arguments": arguments})
            };
            self.emit(sse(done_event, done_payload));
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": state.output_index, "item": item})));
            output.push((state.output_index, item));
        }
        output.sort_by_key(|(index, _)| *index);
        let response = self.response(
            "completed",
            output.into_iter().map(|(_, value)| value).collect(),
        );
        self.emit(sse(
            "response.completed",
            json!({"type": "response.completed", "response": response}),
        ));
    }

    fn response(&self, status: &str, output: Vec<Value>) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "model": self.model,
            "output": output,
            "usage": self.usage,
            "error": Value::Null,
            "incomplete_details": if status == "completed" && self.finish_reason.as_deref() == Some("length") { json!({"reason": "max_output_tokens"}) } else { Value::Null }
        })
    }

    fn failed_event(&self, message: String) -> Bytes {
        let mut response = self.response("failed", Vec::new());
        response["error"] = json!({"type": "upstream_error", "message": message});
        sse(
            "response.failed",
            json!({"type": "response.failed", "response": response}),
        )
    }
}

fn reasoning_delta(delta: &Value) -> Option<String> {
    if let Some(value) = ["reasoning_content", "reasoning", "reasoning_text"]
        .iter()
        .find_map(|field| delta.get(*field))
    {
        let text = text_value(value);
        if !text.is_empty() {
            return Some(text);
        }
    }
    delta
        .get("reasoning_details")
        .map(text_value)
        .filter(|value| !value.is_empty())
}

fn content_delta(payload: &Value) -> Option<String> {
    let mut content = payload.get("content").map(text_value).unwrap_or_default();
    if let Some(refusal) = payload.get("refusal").and_then(Value::as_str) {
        content.push_str(refusal);
    }
    (!content.is_empty()).then_some(content)
}

fn snapshot_suffix<'a>(existing: &str, snapshot: &'a str) -> &'a str {
    snapshot.strip_prefix(existing).unwrap_or(snapshot)
}

fn meaningful_error_message(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => (!value.trim().is_empty()).then(|| value.clone()),
        Value::Object(object) => ["message", "detail", "error_description", "type"]
            .iter()
            .find_map(|key| object.get(*key).and_then(meaningful_error_message))
            .or_else(|| object.get("error").and_then(meaningful_error_message)),
        Value::Array(values) => values.iter().find_map(meaningful_error_message),
        _ => None,
    }
}

fn custom_input(tool_name: &str, arguments: &str) -> String {
    let parsed = serde_json::from_str::<Value>(arguments).ok();
    let input_field = parsed.as_ref().and_then(|value| {
        [CUSTOM_TOOL_INPUT_FIELD, "patch", "content"]
            .iter()
            .find(|field| value.get(**field).and_then(Value::as_str).is_some())
            .copied()
    });
    let input = input_field
        .and_then(|field| parsed.as_ref()?.get(field)?.as_str().map(str::to_owned))
        .unwrap_or_else(|| arguments.to_owned());
    if tool_name == "apply_patch" {
        let normalized = normalize_apply_patch_input(&input);
        log_apply_patch_diagnostics(arguments, input_field, &input, &normalized);
        normalized
    } else {
        input
    }
}

fn log_apply_patch_diagnostics(
    arguments: &str,
    input_field: Option<&str>,
    input: &str,
    normalized: &str,
) {
    let trimmed = input.trim();
    let first_line = trimmed.lines().next().unwrap_or_default();
    let first_line_kind = if first_line == "*** Begin Patch" {
        "begin_patch"
    } else if first_line.starts_with("```") {
        "markdown_fence"
    } else if first_line.starts_with("*** Add File:")
        || first_line.starts_with("*** Update File:")
        || first_line.starts_with("*** Delete File:")
    {
        "file_directive"
    } else if first_line.is_empty() {
        "empty"
    } else {
        "other"
    };
    let begin = trimmed.find("*** Begin Patch");
    let end = trimmed.find("*** End Patch");
    let action = if normalized == input {
        "unchanged"
    } else if begin.is_some() && end.is_some() {
        "extracted_envelope"
    } else if first_line.starts_with("```") {
        "removed_fence_and_added_envelope"
    } else {
        "added_envelope"
    };
    log_executor_event(
        "local model proxy apply_patch normalized",
        &[
            ("arguments_bytes", arguments.len().to_string()),
            (
                "json_parsed",
                serde_json::from_str::<Value>(arguments).is_ok().to_string(),
            ),
            ("input_field", input_field.unwrap_or("raw").to_owned()),
            ("input_bytes", input.len().to_string()),
            ("first_line_kind", first_line_kind.to_owned()),
            (
                "begin_offset",
                begin.map_or_else(|| "none".to_owned(), |value| value.to_string()),
            ),
            (
                "end_offset",
                end.map_or_else(|| "none".to_owned(), |value| value.to_string()),
            ),
            ("normalized_bytes", normalized.len().to_string()),
            ("action", action.to_owned()),
        ],
    );
}

fn normalize_apply_patch_input(input: &str) -> String {
    let trimmed = input.trim();
    let without_fence = trimmed
        .strip_prefix("```diff")
        .or_else(|| trimmed.strip_prefix("```patch"))
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);

    if let Some(begin) = without_fence.find("*** Begin Patch") {
        if let Some(relative_end) = without_fence[begin..].find("*** End Patch") {
            let end = begin + relative_end + "*** End Patch".len();
            return without_fence[begin..end].to_owned();
        }
        // Preserve an incomplete patch so Codex reports the real grammar error.
        return without_fence[begin..].to_owned();
    }

    if without_fence.lines().any(|line| {
        line.starts_with("*** Add File:")
            || line.starts_with("*** Update File:")
            || line.starts_with("*** Delete File:")
            || line.starts_with("*** Move to:")
    }) {
        return format!("*** Begin Patch\n{without_fence}\n*** End Patch");
    }

    without_fence.to_owned()
}

fn normalize_arguments(arguments: &str) -> String {
    if arguments.trim().is_empty() {
        "{}".to_owned()
    } else {
        arguments.to_owned()
    }
}

fn responses_usage(usage: Option<&Value>) -> Value {
    let input = usage
        .and_then(|v| v.get("prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .and_then(|v| v.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .and_then(|v| v.pointer("/prompt_tokens_details/cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .and_then(|v| v.pointer("/completion_tokens_details/reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "input_tokens": input,
        "input_tokens_details": {"cached_tokens": cached},
        "output_tokens": output,
        "output_tokens_details": {"reasoning_tokens": reasoning},
        "total_tokens": input + output
    })
}

fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(&data).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn converts_responses_request_with_history_and_custom_tool() {
        let input = json!({
            "model": "kimi-for-coding",
            "instructions": "You are a coding agent.",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Need patch"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch", "description": "Patch files"}],
            "stream": true
        });

        let (converted, context) = responses_to_chat(&input).expect("request should convert");
        assert!(context.is_custom("apply_patch"));
        assert!(converted["tools"][0]["function"]["description"]
            .as_str()
            .is_some_and(|value| value.contains("Original tool definition:")));
        let description = converted["tools"][0]["function"]["description"]
            .as_str()
            .expect("custom tool description");
        assert!(description.starts_with("Critical apply_patch input contract:"));
        assert!(description.contains("exactly `*** Begin Patch\\n`"));
        assert!(description.contains("with no blank line"));
        assert!(description.contains("Do not include Markdown code fences"));
        assert!(description.contains("every added-file content line must start with `+`"));
        assert!(description.contains("*** Add File: hello.txt\n+first line\n+\n+third line"));
        assert!(description.contains("*** Update File: hello.txt\n@@\n-old line\n+new line"));
        assert_eq!(
            converted["tools"][0]["function"]["parameters"]["properties"]["input"]["description"],
            CUSTOM_TOOL_INPUT_DESCRIPTION
        );
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(
            converted["messages"][2]["tool_calls"][0]["function"]["name"],
            "apply_patch"
        );
        assert_eq!(converted["messages"][2]["reasoning_content"], "Need patch");
        assert_eq!(converted["messages"][3]["role"], "tool");
        assert_eq!(converted["stream_options"]["include_usage"], true);
    }

    #[test]
    fn explains_apply_patch_hunk_failures_and_requests_a_retry() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "apply_patch verification failed: invalid hunk at line 3"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch"}]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let output = converted["messages"][1]["content"]
            .as_str()
            .expect("tool output should be text");

        assert!(output.starts_with("apply_patch verification failed: invalid hunk at line 3"));
        assert!(output.contains("prefix unchanged lines with one space"));
        assert!(output.contains("Correct update example:"));
        assert!(output.contains("Fix the reported error and call `apply_patch` again"));
        assert!(output.contains("Do not switch to shell redirection"));
    }

    #[test]
    fn leaves_successful_apply_patch_output_unchanged() {
        assert_eq!(friendly_apply_patch_output("Done!"), "Done!");
    }

    #[test]
    fn converts_chat_usage_to_responses_usage() {
        assert_eq!(
            responses_usage(Some(&json!({
                "prompt_tokens": 12,
                "completion_tokens": 7,
                "prompt_tokens_details": {"cached_tokens": 3},
                "completion_tokens_details": {"reasoning_tokens": 4}
            }))),
            json!({
                "input_tokens": 12,
                "input_tokens_details": {"cached_tokens": 3},
                "output_tokens": 7,
                "output_tokens_details": {"reasoning_tokens": 4},
                "total_tokens": 19
            })
        );
    }

    #[tokio::test]
    async fn converts_streaming_reasoning_text_and_custom_tool() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from(concat!(
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"kimi-for-coding\",\"created\":1,",
            "\"choices\":[{\"delta\":{\"reasoning_content\":\"plan\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"patch\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
            "data: [DONE]\n\n"
        )))];
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|item| String::from_utf8(item.expect("stream should convert").to_vec()).unwrap())
            .collect::<String>();

        assert!(output.contains("response.reasoning_summary_text.delta"));
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("response.custom_tool_call_input.delta"));
        assert!(output.contains("\"input\":\"patch\""));
        assert!(output.contains("response.completed"));
        assert!(output.contains("\"input_tokens\":10"));
    }

    #[tokio::test]
    async fn normalizes_wrapped_apply_patch_function_arguments() {
        let chunks = vec![Ok::<_, std::io::Error>(Bytes::from(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"patch\\\":\\\"```diff\\\\n*** Update File: a.txt\\\\n@@\\\\n-old\\\\n+new\\\\n```\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
        ))];
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>();

        assert!(output.contains("*** Begin Patch\\n*** Update File: a.txt"));
        assert!(output.contains("+new\\n*** End Patch"));
        assert!(!output.contains("```diff"));
    }

    #[test]
    fn leaves_truncated_apply_patch_incomplete() {
        assert_eq!(
            normalize_apply_patch_input("prefix *** Begin Patch\n*** Update File: a.txt\n@@"),
            "*** Begin Patch\n*** Update File: a.txt\n@@"
        );
    }

    async fn convert_stream(input: &str, context: ToolContext) -> String {
        chat_sse_to_responses(
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                input.to_owned(),
            ))]),
            context,
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
        .collect()
    }

    #[tokio::test]
    async fn converts_legacy_function_call() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"read_file\",\"arguments\":\"{}\"}},\"finish_reason\":\"function_call\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"type\":\"function_call\""));
        assert!(output.contains("\"name\":\"read_file\""));
    }

    #[tokio::test]
    async fn converts_complete_message_tool_calls_without_delta() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"name\":\"read_file\""));
    }

    #[tokio::test]
    async fn reports_truncated_stream_as_failed() {
        let output = convert_stream(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn restores_parallel_fragmented_tool_calls() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}},{\"index\":3,\"id\":\"call_2\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}},{\"index\":3,\"function\":{\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"call_id\":\"call_2\""));
        assert!(output.contains("a.txt"));
        assert!(output.contains("path"));
    }

    #[tokio::test]
    async fn serializes_object_arguments_from_non_streaming_compatible_chunks() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("a.txt"));
        assert!(output.contains("path"));
    }

    #[tokio::test]
    async fn ignores_repeated_complete_tool_name_and_id() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"name\":\"read_file\""));
        assert!(!output.contains("read_fileread_file"));
        assert!(!output.contains("call_1call_1"));
    }

    #[tokio::test]
    async fn accepts_done_marker_without_finish_reason_after_a_choice() {
        let output = convert_stream(
            concat!(
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn handles_crlf_stream_delimiters() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
                "data: [DONE]\r\n\r\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("response.completed"));
    }

    #[tokio::test]
    async fn rejects_done_stream_without_completion_chunks() {
        let output =
            convert_stream(": keepalive\n\ndata: [DONE]\n\n", ToolContext::default()).await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("without a completion choice"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn rejects_choiceless_usage_stream() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":0}}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn converts_upstream_error_event_to_failed_response() {
        let output = convert_stream(
            concat!(
                "data: {\"error\":{\"message\":\"rate limited\",\"type\":\"rate_limit\"}}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("rate limited"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn sparse_large_tool_index_does_not_create_placeholder_calls() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":4000000000,\"id\":\"call_sparse\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_sparse\""));
        assert!(!output.contains("\"call_id\":\"call_0\""));
    }

    #[tokio::test]
    async fn ignores_empty_upstream_error_placeholders() {
        let output = convert_stream(
            concat!(
                "data: {\"error\":{},\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn rejects_named_error_events_without_an_error_wrapper() {
        let output = convert_stream(
            "event: error\ndata: {\"message\":\"quota exhausted\"}\n\n",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("quota exhausted"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn uses_full_message_when_delta_is_empty() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{},\"message\":{\"role\":\"assistant\",\"content\":\"full answer\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("full answer"));
        assert!(output.contains("response.completed"));
    }

    #[tokio::test]
    async fn uses_array_position_for_complete_calls_without_indices() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"first\",\"arguments\":\"{}\"}},{\"id\":\"call_2\",\"function\":{\"name\":\"second\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"call_id\":\"call_2\""));
        assert!(output.contains("\"name\":\"first\""));
        assert!(output.contains("\"name\":\"second\""));
    }

    #[tokio::test]
    async fn selects_choice_zero_instead_of_the_first_choice() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"wrong\"},\"finish_reason\":\"stop\"},{\"index\":0,\"delta\":{\"content\":\"right\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("right"));
        assert!(!output.contains("wrong"));
    }

    #[tokio::test]
    async fn preserves_content_parts_refusal_and_reasoning_details() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.text\",\"text\":\"think\"}],\"content\":[{\"type\":\"text\",\"text\":\"visible\"}],\"refusal\":\" denied\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("think"));
        assert!(output.contains("visible denied"));
    }

    #[tokio::test]
    async fn accepts_bom_and_indented_sse_fields() {
        let output = convert_stream(
            concat!(
                "\u{feff}  data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "  data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(output.contains("ok"));
    }

    #[tokio::test]
    async fn rejects_malformed_complete_sse_blocks() {
        let output = convert_stream(
            "data: {\"choices\":[{not-json}]}\n\n",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("Failed to parse upstream SSE chunk"));
    }

    #[tokio::test]
    async fn ignores_a_truncated_tail_after_a_finish_reason() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"choices\":["
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[test]
    fn responses_to_responses_converts_custom_apply_patch_tool() {
        let input = json!({
            "model": "wework-gpt-5.6-sol",
            "instructions": "You are a coding agent.",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ],
            "tools": [
                {"type": "function", "name": "exec_command", "description": "Run commands", "parameters": {"type": "object", "properties": {}}},
                {"type": "custom", "name": "apply_patch", "description": "Patch files"}
            ],
            "stream": true
        });

        let (converted, context) = responses_to_responses(&input).expect("request should convert");
        assert!(context.is_custom("apply_patch"));
        assert_eq!(converted["tools"][0]["type"], "function");
        assert_eq!(converted["tools"][0]["name"], "exec_command");
        assert_eq!(converted["tools"][0]["description"], "Run commands");
        assert_eq!(converted["tools"][1]["type"], "function");
        assert_eq!(converted["tools"][1]["name"], "apply_patch");
        assert!(converted["tools"][1]["description"]
            .as_str()
            .is_some_and(
                |value| value.starts_with("Critical apply_patch input contract:")
                    && !value.contains("Original tool definition:")
            ));
        assert_eq!(
            converted["tools"][1]["parameters"]["properties"]["input"]["type"],
            "string"
        );
        assert_eq!(converted["input"][1]["type"], "function_call");
        assert_eq!(
            converted["input"][1]["arguments"],
            "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
        );
        assert_eq!(converted["input"][2]["type"], "function_call_output");
    }

    async fn convert_responses_stream(input: &str, context: ToolContext) -> String {
        responses_sse_to_responses(
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                input.to_owned(),
            ))]),
            context,
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
        .collect()
    }

    #[tokio::test]
    async fn responses_sse_to_responses_rewrites_function_call_for_custom_tool() {
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
            "output: {output}"
        );
        assert!(
            !output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("response.custom_tool_call_input.delta"),
            "output: {output}"
        );
        assert!(
            output.contains("response.custom_tool_call_input.done"),
            "output: {output}"
        );
    }

    #[tokio::test]
    async fn responses_sse_to_responses_extracts_input_for_generic_custom_tool() {
        let mut context = ToolContext::default();
        context.insert("my_custom_tool".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"raw custom input\""),
            "output: {output}"
        );
        assert!(!output.contains("\"arguments\""), "output: {output}");
        assert!(
            output.contains("response.custom_tool_call_input.done"),
            "output: {output}"
        );
    }

    #[tokio::test]
    async fn responses_sse_to_responses_extracts_input_from_done_item_without_delta() {
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\"}}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
            "output: {output}"
        );
        assert!(
            !output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(!output.contains("\"arguments\""), "output: {output}");
    }

    #[tokio::test]
    async fn responses_sse_to_responses_leaves_regular_function_calls_unchanged() {
        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}}\n\n"
            ),
            ToolContext::default(),
        )
        .await;

        assert!(
            output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("response.function_call_arguments.delta"),
            "output: {output}"
        );
        assert!(!output.contains("custom_tool_call"), "output: {output}");
    }
}
