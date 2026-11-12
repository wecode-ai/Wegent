// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses to Anthropic Messages compatibility for Codex.

use std::{collections::VecDeque, pin::Pin};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::logging::log_executor_event;

use super::{
    chat::{self, ToolContext},
    take_sse_block, vision, DEFAULT_MAX_OUTPUT_TOKENS,
};

pub(super) fn responses_to_anthropic(body: &Value) -> Result<(Value, ToolContext), String> {
    let (chat_body, context) = chat::responses_to_chat_for_anthropic(body)?;
    let mut result = Map::new();
    if let Some(model) = chat_body.get("model") {
        result.insert("model".to_owned(), model.clone());
    }
    result.insert(
        "max_tokens".to_owned(),
        chat_body
            .get("max_tokens")
            .cloned()
            .unwrap_or_else(|| Value::from(DEFAULT_MAX_OUTPUT_TOKENS)),
    );
    result.insert("stream".to_owned(), Value::Bool(true));

    let mut system = Vec::new();
    let mut messages = Vec::new();
    for message in chat_body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match message.get("role").and_then(Value::as_str) {
            Some("system") => system.push(text_value(message.get("content"))),
            Some("tool") => append_tool_result(message, &mut messages),
            Some("assistant") => messages.push(assistant_message(message)),
            _ => append_user_content(anthropic_content(message.get("content")), &mut messages),
        }
    }
    if !system.is_empty() {
        result.insert("system".to_owned(), Value::String(system.join("\n\n")));
    }
    result.insert("messages".to_owned(), Value::Array(messages));

    for field in ["temperature", "top_p", "stop"] {
        if let Some(value) = chat_body.get(field) {
            let target = if field == "stop" {
                "stop_sequences"
            } else {
                field
            };
            result.insert(target.to_owned(), value.clone());
        }
    }
    if let Some(tools) = chat_body.get("tools").and_then(Value::as_array) {
        result.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .filter_map(|tool| tool.get("function"))
                    .map(|function| {
                        json!({
                            "name": function.get("name").cloned().unwrap_or(Value::Null),
                            "description": function.get("description").cloned().unwrap_or(Value::Null),
                            "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object"}))
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(choice) = chat_body.get("tool_choice") {
        result.insert("tool_choice".to_owned(), anthropic_tool_choice(choice));
    }
    Ok((Value::Object(result), context))
}

fn assistant_message(message: &Value) -> Value {
    let mut content = Vec::new();
    let text = text_value(message.get("content"));
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    for call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let function = call.get("function").unwrap_or(&Value::Null);
        let input = function
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or_else(|| json!({}));
        content.push(json!({
            "type": "tool_use",
            "id": call.get("id").cloned().unwrap_or(Value::Null),
            "name": function.get("name").cloned().unwrap_or(Value::Null),
            "input": input
        }));
    }
    json!({"role": "assistant", "content": content})
}

fn append_tool_result(message: &Value, messages: &mut Vec<Value>) {
    let block = json!({
        "type": "tool_result",
        "tool_use_id": message.get("tool_call_id").cloned().unwrap_or(Value::Null),
        "content": text_value(message.get("content"))
    });
    append_user_content(Value::Array(vec![block]), messages);
}

fn append_user_content(content: Value, messages: &mut Vec<Value>) {
    let Value::Array(content) = content else {
        messages.push(json!({"role": "user", "content": content}));
        return;
    };
    if let Some(last) = messages
        .last_mut()
        .filter(|value| value.get("role").and_then(Value::as_str) == Some("user"))
    {
        if let Some(existing) = last.get_mut("content").and_then(Value::as_array_mut) {
            existing.extend(content);
            return;
        }
    }
    messages.push(json!({"role": "user", "content": Value::Array(content)}));
}

fn anthropic_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(parts)) => Value::Array(
            parts
                .iter()
                .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                    Some("text") => Some(part.clone()),
                    Some("image_url") => image_block(part.get("image_url")),
                    _ => None,
                })
                .collect(),
        ),
        value => Value::Array(vec![json!({"type": "text", "text": text_value(value)})]),
    }
}

fn image_block(value: Option<&Value>) -> Option<Value> {
    let url = value
        .and_then(|value| value.get("url").or(Some(value)))
        .and_then(Value::as_str)?;
    Some(vision::anthropic_image_block(url))
}

fn anthropic_tool_choice(choice: &Value) -> Value {
    if let Some(name) = choice.pointer("/function/name").and_then(Value::as_str) {
        json!({"type": "tool", "name": name})
    } else if choice == "required" {
        json!({"type": "any"})
    } else {
        json!({"type": "auto"})
    }
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

struct AnthropicStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
    output: VecDeque<Result<Bytes, std::io::Error>>,
    response_id: String,
    model: String,
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_creation_input_tokens: u64,
    output_tokens: u64,
    output_observed: bool,
}

pub(super) fn anthropic_sse_to_responses<S, E>(
    stream: S,
    context: ToolContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    let state = AnthropicStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        pending_utf8: Vec::new(),
        output: VecDeque::new(),
        response_id: "msg_wework_anthropic".to_owned(),
        model: String::new(),
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        output_observed: false,
    };
    chat::chat_sse_to_responses(anthropic_to_chat_stream(state).fuse(), context)
}

pub(super) fn anthropic_response_to_chat(response: &Value) -> Value {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    for block in response
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
            Some("thinking") => {
                reasoning.push_str(block.get("thinking").and_then(Value::as_str).unwrap_or(""))
            }
            Some("tool_use") => tool_calls.push(json!({
                "id": block.get("id").cloned().unwrap_or(Value::Null),
                "type": "function",
                "function": {
                    "name": block.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": serde_json::to_string(
                        block.get("input").unwrap_or(&Value::Null)
                    ).unwrap_or_else(|_| "{}".to_owned())
                }
            })),
            _ => {}
        }
    }
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { Value::String(text) }
    });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let stop_reason = response
        .get("stop_reason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn");
    let usage = anthropic_usage_to_chat(response.get("usage"));
    json!({
        "id": response.get("id").cloned().unwrap_or_else(|| json!("msg_wework_anthropic")),
        "model": response.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{
            "message": message,
            "finish_reason": if stop_reason == "max_tokens" { "length" } else if stop_reason == "tool_use" { "tool_calls" } else { "stop" }
        }],
        "usage": usage
    })
}

fn anthropic_usage_to_chat(usage: Option<&Value>) -> Value {
    let input_tokens = usage
        .and_then(|value| value.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached_input_tokens = usage
        .and_then(|value| value.get("cache_read_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_creation_input_tokens = usage
        .and_then(|value| value.get("cache_creation_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|value| value.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let prompt_tokens = input_tokens
        .saturating_add(cached_input_tokens)
        .saturating_add(cache_creation_input_tokens);

    json!({
        "prompt_tokens": prompt_tokens,
        "prompt_tokens_details": {"cached_tokens": cached_input_tokens},
        "completion_tokens": output_tokens
    })
}

fn anthropic_to_chat_stream<S, E>(
    state: AnthropicStreamState<S>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) = super::append_stream_utf8(
                        &mut state.pending,
                        &mut state.pending_utf8,
                        &bytes,
                    ) {
                        return Some((Err(error), state));
                    }
                    while let Some(block) = take_sse_block(&mut state.pending) {
                        state.handle_block(&block);
                    }
                }
                Some(Err(error)) => {
                    return Some((Err(std::io::Error::other(error.to_string())), state));
                }
                None => {
                    if let Err(error) = super::finish_stream_utf8(&state.pending_utf8) {
                        return Some((Err(error), state));
                    }
                    if state.pending.trim().is_empty() {
                        return None;
                    }
                    let trailing = std::mem::take(&mut state.pending);
                    state.handle_block(&trailing);
                }
            }
        }
    })
}

impl<S> AnthropicStreamState<S> {
    fn handle_block(&mut self, block: &str) {
        if let Some(event) = super::sse::json(block) {
            self.handle_event(&event);
        }
    }

    fn handle_event(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let message = event.get("message").unwrap_or(&Value::Null);
                self.response_id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("msg_wework_anthropic")
                    .to_owned();
                self.model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                self.input_tokens = message
                    .pointer("/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.cached_input_tokens = message
                    .pointer("/usage/cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.cache_creation_input_tokens = message
                    .pointer("/usage/cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.emit(json!({"choices": [{"delta": {}}]}));
            }
            Some("content_block_start") => self.start_content_block(event),
            Some("content_block_delta") => self.content_delta(event),
            Some("message_delta") => {
                self.output_tokens = event
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.output_tokens);
                let upstream_stop = event.pointer("/delta/stop_reason").and_then(Value::as_str);
                if upstream_stop.is_some() && self.output_tokens > 0 && !self.output_observed {
                    log_executor_event(
                        "local model proxy anthropic empty response",
                        &[
                            ("output_tokens", self.output_tokens.to_string()),
                            ("stop_reason", upstream_stop.unwrap_or_default().to_owned()),
                        ],
                    );
                    self.emit(json!({
                        "error": {
                            "type": "upstream_empty_response",
                            "message": "Anthropic upstream reported output tokens without returning content"
                        }
                    }));
                    return;
                }
                let stop = upstream_stop.map(anthropic_finish_reason);
                if let Some(upstream_stop) = upstream_stop {
                    log_executor_event(
                        "local model proxy anthropic stop reason",
                        &[
                            ("upstream_stop_reason", upstream_stop.to_owned()),
                            (
                                "mapped_finish_reason",
                                anthropic_finish_reason(upstream_stop).to_owned(),
                            ),
                            ("output_tokens", self.output_tokens.to_string()),
                        ],
                    );
                }
                let prompt_tokens = self
                    .input_tokens
                    .saturating_add(self.cached_input_tokens)
                    .saturating_add(self.cache_creation_input_tokens);
                self.emit(json!({
                    "choices": [{"delta": {}, "finish_reason": stop}],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "prompt_tokens_details": {"cached_tokens": self.cached_input_tokens},
                        "completion_tokens": self.output_tokens
                    }
                }));
            }
            Some("error") => self.emit(json!({"error": event.get("error")})),
            _ => {}
        }
    }

    fn start_content_block(&mut self, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        let block = event.get("content_block").unwrap_or(&Value::Null);
        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
            self.output_observed = true;
            log_executor_event(
                "local model proxy anthropic tool use",
                &[
                    ("tool_index", index.to_string()),
                    (
                        "tool_name",
                        block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                ],
            );
            self.emit(json!({"choices": [{"delta": {"tool_calls": [{
                "index": index,
                "id": block.get("id"),
                "type": "function",
                "function": {"name": block.get("name"), "arguments": ""}
            }]}}]}));
        }
    }

    fn content_delta(&mut self, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        let delta = event.get("delta").unwrap_or(&Value::Null);
        let chat_delta = match delta.get("type").and_then(Value::as_str) {
            Some("text_delta") => {
                self.output_observed |= delta
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty());
                json!({"content": delta.get("text")})
            }
            Some("thinking_delta") => {
                self.output_observed |= delta
                    .get("thinking")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty());
                json!({"reasoning_content": delta.get("thinking")})
            }
            Some("input_json_delta") => {
                self.output_observed = true;
                json!({"tool_calls": [{
                    "index": index,
                    "function": {"arguments": delta.get("partial_json")}
                }]})
            }
            _ => return,
        };
        self.emit(json!({"choices": [{"delta": chat_delta}]}));
    }

    fn emit(&mut self, mut value: Value) {
        value["id"] = Value::String(format!("chatcmpl-{}", self.response_id));
        value["model"] = Value::String(self.model.clone());
        self.output.push_back(Ok(Bytes::from(format!(
            "data: {}\n\n",
            serde_json::to_string(&value).unwrap_or_default()
        ))));
    }
}

fn anthropic_finish_reason(value: &str) -> &str {
    match value {
        "max_tokens" => "length",
        "tool_use" => "tool_calls",
        _ => "stop",
    }
}

#[cfg(test)]
#[path = "anthropic/tests/mod.rs"]
mod tests;
