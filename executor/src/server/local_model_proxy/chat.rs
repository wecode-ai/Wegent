// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses to Chat Completions compatibility for Codex.
//!
//! Codex no longer accepts `wire_api = "chat"`, so providers exposing only
//! Chat Completions must be adapted at the local executor boundary. The event
//! shapes and custom-tool mapping preserve Codex semantics across protocols.

use std::{collections::BTreeMap, pin::Pin};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

const CUSTOM_TOOL_INPUT_FIELD: &str = "input";

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
                let description = tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex custom tool. Preserve the raw input exactly.");
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
                                    "description": "Raw input for the Codex custom tool."
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
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(block) = take_sse_block(&mut state.pending) {
                        state.handle_block(&block);
                    }
                }
                Some(Err(error)) => {
                    let event = state.failed_event(error.to_string());
                    return Some((Ok(event), state));
                }
                None => {
                    state.finish();
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

    fn handle_block(&mut self, block: &str) {
        for data in block.lines().filter_map(|line| line.strip_prefix("data:")) {
            let data = data.trim();
            if data == "[DONE]" {
                self.finish();
                continue;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(error) = chunk.get("error") {
                self.emit(self.failed_event(text_value(error)));
                self.completed = true;
                continue;
            }
            self.handle_chunk(&chunk);
        }
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
            .and_then(|v| v.first())
        else {
            return;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(reasoning) = reasoning_delta(delta) {
                self.push_reasoning(&reasoning);
            }
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                self.push_text(content);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.push_call(call);
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
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

    fn push_call(&mut self, call: &Value) {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
        let function = call.get("function").unwrap_or(&Value::Null);
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (needs_start, call_id, complete_name) = {
            let state = self.calls.entry(index).or_default();
            if !id.is_empty() {
                state.call_id.push_str(id);
            }
            if !name.is_empty() {
                state.name.push_str(name);
            }
            if !arguments.is_empty() {
                state.arguments.push_str(arguments);
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
                custom_input(&state.arguments)
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

fn take_sse_block(buffer: &mut String) -> Option<String> {
    let index = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n"))?;
    let delimiter_len = if buffer[index..].starts_with("\r\n\r\n") {
        4
    } else {
        2
    };
    let block = buffer[..index].to_owned();
    buffer.drain(..index + delimiter_len);
    Some(block)
}

fn reasoning_delta(delta: &Value) -> Option<String> {
    ["reasoning_content", "reasoning", "reasoning_text"]
        .iter()
        .find_map(|field| delta.get(*field).and_then(Value::as_str).map(str::to_owned))
}

fn custom_input(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get(CUSTOM_TOOL_INPUT_FIELD)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| arguments.to_owned())
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
}
