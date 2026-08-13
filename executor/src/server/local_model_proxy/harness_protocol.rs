// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Protocol-neutral harness request model and peer wire-protocol adapters.

use std::collections::HashSet;

use axum::{body::Bytes, http::StatusCode};
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Map, Value};

use super::HttpError;

#[derive(Debug, Clone, PartialEq)]
struct HarnessRequest {
    model: String,
    system: Vec<ContentBlock>,
    messages: Vec<Message>,
    tools: Vec<Tool>,
    tool_choice: Option<ToolChoice>,
    max_tokens: Option<u64>,
    temperature: Option<f64>,
    raw_messages_request: Value,
}

#[derive(Debug, Clone, PartialEq)]
struct Message {
    role: Role,
    content: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
enum ContentBlock {
    Text(String),
    Thinking(String),
    Image {
        media_type: String,
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct Tool {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum ToolChoice {
    Auto,
    Required,
    None,
    Tool(String),
}

pub(super) fn adapt_messages_request(
    body: &[u8],
    upstream_format: &str,
    model_id: Option<&str>,
) -> Result<Vec<u8>, HttpError> {
    let request = decode_messages_request(body)?;
    let adapted = match upstream_format {
        "anthropic-messages" => encode_messages_request(&request, model_id),
        "openai-chat-completions" => encode_chat_request(&request, model_id),
        "openai-responses" => encode_responses_request(&request, model_id),
        other => {
            return Err(HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: format!("Unsupported harness upstream API format: {other}"),
            })
        }
    };
    serde_json::to_vec(&adapted).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode harness upstream request: {error}"),
    })
}

fn decode_messages_request(body: &[u8]) -> Result<HarnessRequest, HttpError> {
    let raw: Value = serde_json::from_slice(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Anthropic Messages request: {error}"),
    })?;
    let object = raw.as_object().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Anthropic Messages request body must be an object".to_owned(),
    })?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("wework-model")
        .to_owned();
    let system = decode_content(object.get("system"), Role::User)?;
    let mut messages = object
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|message| {
            let role = match message.get("role").and_then(Value::as_str) {
                Some("assistant") => Role::Assistant,
                _ => Role::User,
            };
            Ok(Message {
                role,
                content: decode_content(message.get("content"), role)?,
            })
        })
        .collect::<Result<Vec<_>, HttpError>>()?;
    close_unresolved_tool_uses(&mut messages);
    let tools = object
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            Some(Tool {
                name: tool.get("name")?.as_str()?.to_owned(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                input_schema: tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object"})),
            })
        })
        .collect();
    Ok(HarnessRequest {
        model,
        system,
        messages,
        tools,
        tool_choice: object.get("tool_choice").and_then(decode_tool_choice),
        max_tokens: object.get("max_tokens").and_then(Value::as_u64),
        temperature: object.get("temperature").and_then(Value::as_f64),
        raw_messages_request: raw,
    })
}

fn close_unresolved_tool_uses(messages: &mut Vec<Message>) {
    let resolved = messages
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    let mut pending = Vec::new();
    let mut normalized = Vec::with_capacity(messages.len());

    for message in messages.drain(..) {
        if message.role == Role::User && !pending.is_empty() {
            normalized.push(Message {
                role: Role::User,
                content: pending.drain(..).map(missing_tool_result).collect(),
            });
        }

        pending.extend(message.content.iter().filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } if !resolved.contains(id) => Some(id.clone()),
            _ => None,
        }));
        normalized.push(message);
    }

    if !pending.is_empty() {
        normalized.push(Message {
            role: Role::User,
            content: pending.drain(..).map(missing_tool_result).collect(),
        });
    }
    *messages = normalized;
}

fn missing_tool_result(tool_use_id: String) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id,
        content: "Tool execution failed before producing a result.".to_owned(),
    }
}

fn decode_content(value: Option<&Value>, role: Role) -> Result<Vec<ContentBlock>, HttpError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if let Some(text) = value.as_str() {
        return Ok(vec![ContentBlock::Text(text.to_owned())]);
    }
    let Some(blocks) = value.as_array() else {
        return Ok(Vec::new());
    };
    blocks
        .iter()
        .filter_map(|block| {
            let block_type = block.get("type")?.as_str()?;
            match block_type {
                "text" => Some(Ok(ContentBlock::Text(
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                ))),
                "thinking" => Some(Ok(ContentBlock::Thinking(
                    block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                ))),
                "image" => {
                    let source = block.get("source")?;
                    Some(Ok(ContentBlock::Image {
                        media_type: source.get("media_type")?.as_str()?.to_owned(),
                        data: source.get("data")?.as_str()?.to_owned(),
                    }))
                }
                "tool_use" => Some(Ok(ContentBlock::ToolUse {
                    id: block.get("id")?.as_str()?.to_owned(),
                    name: block.get("name")?.as_str()?.to_owned(),
                    input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                })),
                "tool_result" => Some(Ok(ContentBlock::ToolResult {
                    tool_use_id: block.get("tool_use_id")?.as_str()?.to_owned(),
                    content: content_text(block.get("content")),
                })),
                _ if role == Role::Assistant => None,
                _ => None,
            }
        })
        .collect()
}

fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn decode_tool_choice(value: &Value) -> Option<ToolChoice> {
    match value.get("type").and_then(Value::as_str)? {
        "auto" => Some(ToolChoice::Auto),
        "any" => Some(ToolChoice::Required),
        "none" => Some(ToolChoice::None),
        "tool" => Some(ToolChoice::Tool(value.get("name")?.as_str()?.to_owned())),
        _ => None,
    }
}

fn encode_messages_request(request: &HarnessRequest, model_id: Option<&str>) -> Value {
    let mut raw = request.raw_messages_request.clone();
    if let Some(object) = raw.as_object_mut() {
        object.insert(
            "model".to_owned(),
            Value::String(model_id.unwrap_or(&request.model).to_owned()),
        );
        object.insert("stream".to_owned(), Value::Bool(true));
    }
    raw
}

fn encode_chat_request(request: &HarnessRequest, model_id: Option<&str>) -> Value {
    let mut messages = Vec::new();
    let system = blocks_text(&request.system);
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    for message in &request.messages {
        let role = if message.role == Role::Assistant {
            "assistant"
        } else {
            "user"
        };
        let text = blocks_text(&message.content);
        let tool_calls = message
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => Some(json!({
                    "id": id,
                    "type": "function",
                    "function": {"name": name, "arguments": input.to_string()}
                })),
                _ => None,
            })
            .collect::<Vec<_>>();
        if !text.is_empty() || !tool_calls.is_empty() {
            let mut encoded = Map::new();
            encoded.insert("role".to_owned(), Value::String(role.to_owned()));
            encoded.insert(
                "content".to_owned(),
                if text.is_empty() {
                    Value::Null
                } else {
                    Value::String(text)
                },
            );
            if !tool_calls.is_empty() {
                encoded.insert("tool_calls".to_owned(), Value::Array(tool_calls));
            }
            messages.push(Value::Object(encoded));
        }
        for block in &message.content {
            if let ContentBlock::ToolResult {
                tool_use_id,
                content,
            } = block
            {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content
                }));
            }
        }
    }
    compact_object(json!({
        "model": model_id.unwrap_or(&request.model),
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_tokens": request.max_tokens,
        "temperature": request.temperature,
        "tools": request.tools.iter().map(|tool| json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema
            }
        })).collect::<Vec<_>>(),
        "tool_choice": request.tool_choice.as_ref().map(chat_tool_choice)
    }))
}

fn encode_responses_request(request: &HarnessRequest, model_id: Option<&str>) -> Value {
    let mut input = Vec::new();
    for message in &request.messages {
        let role = if message.role == Role::Assistant {
            "assistant"
        } else {
            "user"
        };
        let mut content = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text(text) | ContentBlock::Thinking(text) => content.push(json!({
                    "type": if message.role == Role::Assistant { "output_text" } else { "input_text" },
                    "text": text
                })),
                ContentBlock::Image { media_type, data } => content.push(json!({
                    "type": "input_image",
                    "image_url": format!("data:{media_type};base64,{data}")
                })),
                ContentBlock::ToolUse { id, name, input: arguments } => input.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": arguments.to_string()
                })),
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                } => input.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": content
                })),
            }
        }
        if !content.is_empty() {
            input.push(json!({"type": "message", "role": role, "content": content}));
        }
    }
    compact_object(json!({
        "model": model_id.unwrap_or(&request.model),
        "instructions": blocks_text(&request.system),
        "input": input,
        "stream": true,
        "max_output_tokens": request.max_tokens,
        "temperature": request.temperature,
        "tools": request.tools.iter().map(|tool| json!({
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema
        })).collect::<Vec<_>>(),
        "tool_choice": request.tool_choice.as_ref().map(responses_tool_choice)
    }))
}

fn compact_object(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| {
            !value.is_null()
                && !matches!(value, Value::String(text) if text.is_empty())
                && !matches!(value, Value::Array(items) if items.is_empty())
        });
    }
    value
}

fn blocks_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) | ContentBlock::Thinking(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn chat_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Required => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool(name) => json!({"type": "function", "function": {"name": name}}),
    }
}

fn responses_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Required => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool(name) => json!({"type": "function", "name": name}),
    }
}

pub(super) fn adapt_upstream_json_response(
    upstream_format: &str,
    body: &Value,
) -> Result<Value, HttpError> {
    match upstream_format {
        "anthropic-messages" => Ok(body.clone()),
        "openai-chat-completions" => Ok(chat_json_to_messages(body)),
        "openai-responses" => Ok(responses_json_to_messages(body)),
        other => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Unsupported harness upstream API format: {other}"),
        }),
    }
}

fn chat_json_to_messages(body: &Value) -> Value {
    let choice = body.pointer("/choices/0");
    let message = choice.and_then(|value| value.get("message"));
    let mut content = Vec::new();
    if let Some(text) = message
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
    {
        content.push(json!({"type": "text", "text": text}));
    }
    for call in message
        .and_then(|value| value.get("tool_calls"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        content.push(json!({
            "type": "tool_use",
            "id": call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
            "name": call.pointer("/function/name").cloned().unwrap_or_else(|| json!("tool")),
            "input": call.pointer("/function/arguments").and_then(Value::as_str).and_then(|value| serde_json::from_str(value).ok()).unwrap_or_else(|| json!({}))
        }));
    }
    json!({
        "id": body.get("id").cloned().unwrap_or_else(|| json!(format!("msg_{}", uuid::Uuid::new_v4().simple()))),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": body.get("model").cloned().unwrap_or_else(|| json!("wework-model")),
        "stop_reason": if content.iter().any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use")) { "tool_use" } else { "end_turn" },
        "stop_sequence": null,
        "usage": {
            "input_tokens": body.pointer("/usage/prompt_tokens").cloned().unwrap_or_else(|| json!(0)),
            "output_tokens": body.pointer("/usage/completion_tokens").cloned().unwrap_or_else(|| json!(0))
        }
    })
}

fn responses_json_to_messages(body: &Value) -> Value {
    let response = body.get("response").unwrap_or(body);
    let mut content = Vec::new();
    for item in response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for block in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        content.push(json!({"type": "text", "text": text}));
                    }
                }
            }
            Some("function_call") => content.push(json!({
                "type": "tool_use",
                "id": item.get("call_id").cloned().unwrap_or_else(|| json!("tool-call")),
                "name": item.get("name").cloned().unwrap_or_else(|| json!("tool")),
                "input": item.get("arguments").and_then(Value::as_str).and_then(|value| serde_json::from_str(value).ok()).unwrap_or_else(|| json!({}))
            })),
            _ => {}
        }
    }
    json!({
        "id": response.get("id").cloned().unwrap_or_else(|| json!(format!("msg_{}", uuid::Uuid::new_v4().simple()))),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": response.get("model").cloned().unwrap_or_else(|| json!("wework-model")),
        "stop_reason": if content.iter().any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use")) { "tool_use" } else { "end_turn" },
        "stop_sequence": null,
        "usage": {
            "input_tokens": response.pointer("/usage/input_tokens").cloned().unwrap_or_else(|| json!(0)),
            "output_tokens": response.pointer("/usage/output_tokens").cloned().unwrap_or_else(|| json!(0))
        }
    })
}

pub(super) fn adapt_upstream_sse<S, E>(
    upstream_format: String,
    source: S,
) -> impl Stream<Item = Result<Bytes, E>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Send + 'static,
{
    let state = StreamAdapterState {
        source: Box::pin(source),
        upstream_format,
        input_buffer: String::new(),
        output_buffer: message_start_event(),
        open_blocks: HashSet::new(),
        tool_seen: false,
        completed: false,
    };
    stream::unfold(state, |mut state| async move {
        loop {
            if !state.output_buffer.is_empty() {
                return Some((
                    Ok(Bytes::from(std::mem::take(&mut state.output_buffer))),
                    state,
                ));
            }
            if state.completed {
                return None;
            }
            match state.source.next().await {
                Some(Ok(bytes)) => {
                    state
                        .input_buffer
                        .push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(index) = state.input_buffer.find("\n\n") {
                        let event = state.input_buffer[..index].to_owned();
                        state.input_buffer.drain(..index + 2);
                        let converted = if state.upstream_format == "openai-chat-completions" {
                            convert_chat_sse_event(&event, &mut state)
                        } else {
                            convert_responses_sse_event(&event, &mut state)
                        };
                        state.output_buffer.push_str(&converted);
                    }
                }
                Some(Err(error)) => return Some((Err(error), state)),
                None => {
                    let finished = finish_stream(&mut state, None);
                    state.output_buffer.push_str(&finished);
                    state.completed = true;
                }
            }
        }
    })
}

struct StreamAdapterState<S> {
    source: std::pin::Pin<Box<S>>,
    upstream_format: String,
    input_buffer: String,
    output_buffer: String,
    open_blocks: HashSet<usize>,
    tool_seen: bool,
    completed: bool,
}

fn event_data(event: &str) -> Option<Value> {
    let data = event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

fn convert_chat_sse_event<S>(event: &str, state: &mut StreamAdapterState<S>) -> String {
    let Some(value) = event_data(event) else {
        return String::new();
    };
    let delta = value.pointer("/choices/0/delta");
    let mut output = String::new();
    if let Some(text) = delta
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
    {
        output.push_str(&text_delta(state, 0, text));
    }
    for call in delta
        .and_then(|value| value.get("tool_calls"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize + 1;
        if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
            state.tool_seen = true;
            state.open_blocks.insert(index);
            output.push_str(&sse(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
                        "name": name,
                        "input": {}
                    }
                }),
            ));
        }
        if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
            output.push_str(&sse(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": arguments}
                }),
            ));
        }
    }
    if value
        .pointer("/choices/0/finish_reason")
        .is_some_and(|value| !value.is_null())
    {
        state.completed = true;
        output.push_str(&finish_stream(state, value.get("usage")));
    }
    output
}

fn convert_responses_sse_event<S>(event: &str, state: &mut StreamAdapterState<S>) -> String {
    let Some(value) = event_data(event) else {
        return String::new();
    };
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" | "response.reasoning_summary_text.delta" => {
            let index = value
                .get("output_index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            text_delta(
                state,
                index,
                value
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        }
        "response.output_item.added"
            if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") =>
        {
            let index = value
                .get("output_index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            state.open_blocks.insert(index);
            state.tool_seen = true;
            sse(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": value.pointer("/item/call_id").cloned().unwrap_or_else(|| json!("tool-call")),
                        "name": value.pointer("/item/name").cloned().unwrap_or_else(|| json!("tool")),
                        "input": {}
                    }
                }),
            )
        }
        "response.function_call_arguments.delta" => sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": value.get("output_index").cloned().unwrap_or_else(|| json!(0)),
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": value.get("delta").cloned().unwrap_or_else(|| json!(""))
                }
            }),
        ),
        "response.output_item.done" => close_block(
            state,
            value
                .get("output_index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        ),
        "response.completed" => {
            state.completed = true;
            finish_stream(state, value.pointer("/response/usage"))
        }
        _ => String::new(),
    }
}

fn text_delta<S>(state: &mut StreamAdapterState<S>, index: usize, text: &str) -> String {
    let mut output = String::new();
    if state.open_blocks.insert(index) {
        output.push_str(&sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "text", "text": ""}
            }),
        ));
    }
    output.push_str(&sse(
        "content_block_delta",
        json!({
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "text_delta", "text": text}
        }),
    ));
    output
}

fn close_block<S>(state: &mut StreamAdapterState<S>, index: usize) -> String {
    if state.open_blocks.remove(&index) {
        sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": index}),
        )
    } else {
        String::new()
    }
}

fn finish_stream<S>(state: &mut StreamAdapterState<S>, usage: Option<&Value>) -> String {
    let mut output = String::new();
    let mut blocks = state.open_blocks.iter().copied().collect::<Vec<_>>();
    blocks.sort_unstable();
    for index in blocks {
        output.push_str(&close_block(state, index));
    }
    let output_tokens = usage
        .and_then(|value| {
            value
                .get("output_tokens")
                .or_else(|| value.get("completion_tokens"))
        })
        .cloned()
        .unwrap_or_else(|| json!(0));
    output.push_str(&sse(
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": if state.tool_seen { "tool_use" } else { "end_turn" },
                "stop_sequence": null
            },
            "usage": {"output_tokens": output_tokens}
        }),
    ));
    output.push_str(&sse("message_stop", json!({"type": "message_stop"})));
    output
}

fn message_start_event() -> String {
    sse(
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "wework-model",
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0}
            }
        }),
    )
}

fn sse(event: &str, value: Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;

    #[test]
    fn messages_and_responses_are_peer_adapters_over_ir() {
        let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "system": "Be useful",
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "call-1", "name": "shell", "input": {"command": "pwd"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "ok"}]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();
        let responses: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
        )
        .unwrap();
        let chat: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-chat-completions", Some("chat-test")).unwrap(),
        )
        .unwrap();
        let messages: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "anthropic-messages", Some("claude-upstream"))
                .unwrap(),
        )
        .unwrap();

        assert_eq!(responses["model"], "gpt-test");
        assert_eq!(responses["input"][1]["type"], "function_call");
        assert!(responses.get("temperature").is_none());
        assert!(responses.get("tool_choice").is_none());
        assert_eq!(chat["model"], "chat-test");
        assert_eq!(chat["messages"][3]["role"], "tool");
        assert!(chat.get("temperature").is_none());
        assert!(chat.get("tool_choice").is_none());
        assert_eq!(messages["model"], "claude-upstream");
        assert_eq!(messages["messages"][1]["content"][0]["type"], "tool_use");
    }

    #[test]
    fn native_messages_adapter_preserves_unknown_capability_fields() {
        let source = serde_json::to_vec(&json!({
            "model": "harness-alias",
            "max_tokens": 2048,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "hello",
                    "cache_control": {"type": "ephemeral"}
                }]
            }]
        }))
        .unwrap();

        let messages: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "anthropic-messages", Some("claude-upstream"))
                .unwrap(),
        )
        .unwrap();

        assert_eq!(messages["model"], "claude-upstream");
        assert_eq!(messages["stream"], true);
        assert_eq!(messages["thinking"]["budget_tokens"], 1024);
        assert_eq!(
            messages["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn closes_unresolved_tool_uses_for_responses_and_chat_adapters() {
        let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": "inspect the machine"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-ok", "name": "shell", "input": {"command": "uptime"}},
                    {"type": "tool_use", "id": "call-denied", "name": "shell", "input": {"command": "top -l 1 -n 0"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-ok", "content": "up 14 days"},
                    {"type": "text", "text": "continue"}
                ]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();

        let responses: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
        )
        .unwrap();
        let chat: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-chat-completions", Some("chat-test")).unwrap(),
        )
        .unwrap();

        let responses_result = responses["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some("call-denied")
            })
            .expect("synthetic Responses tool result");
        assert_eq!(
            responses_result["output"],
            "Tool execution failed before producing a result."
        );

        let chat_result = chat["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| {
                message.get("role").and_then(Value::as_str) == Some("tool")
                    && message.get("tool_call_id").and_then(Value::as_str) == Some("call-denied")
            })
            .expect("synthetic chat tool result");
        assert_eq!(
            chat_result["content"],
            "Tool execution failed before producing a result."
        );
    }

    #[test]
    fn preserves_split_parallel_tool_results_that_arrive_out_of_order() {
        let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": "inspect the repository"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-00", "name": "shell", "input": {"command": "pwd"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-01", "name": "shell", "input": {"command": "git status"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-02", "name": "shell", "input": {"command": "git log -1"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-00", "content": "workspace"}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-02", "content": "latest commit"}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-01", "content": "clean"}
                ]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();

        let responses: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
        )
        .unwrap();
        let input = responses["input"].as_array().unwrap();

        for call_id in ["call-00", "call-01", "call-02"] {
            let outputs = input
                .iter()
                .filter(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call_output")
                        && item.get("call_id").and_then(Value::as_str) == Some(call_id)
                })
                .count();
            assert_eq!(outputs, 1, "{call_id} should have exactly one output");
        }
        assert!(!input.iter().any(|item| {
            item.get("output").and_then(Value::as_str)
                == Some("Tool execution failed before producing a result.")
        }));
    }

    #[tokio::test]
    async fn chat_stream_adapter_emits_tool_use_messages_sse() {
        let source = stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\"}}]}}]}\n\n",
            )),
            Ok(Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"pwd\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"completion_tokens\":3}}\n\n",
            )),
        ]);
        let output = adapt_upstream_sse("openai-chat-completions".to_owned(), source)
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .concat();
        let text = String::from_utf8(output).unwrap();

        assert!(text.contains("\"name\":\"shell\""));
        assert!(text.contains("\"partial_json\""));
        assert!(text.contains("command"));
        assert!(text.contains("pwd"));
        assert!(text.contains("\"stop_reason\":\"tool_use\""));
        assert!(text.contains("event: message_stop"));
    }

    #[tokio::test]
    async fn responses_stream_adapter_emits_messages_sse() {
        let source = stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(
                "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hello\"}\n\n",
            )),
            Ok(Bytes::from(
                "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"output_tokens\":1}}}\n\n",
            )),
        ]);
        let output = adapt_upstream_sse("openai-responses".to_owned(), source)
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .concat();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("\"text\":\"hello\""));
        assert!(text.contains("event: message_stop"));
    }
}
