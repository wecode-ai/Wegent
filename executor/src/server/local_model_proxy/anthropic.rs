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
    DEFAULT_MAX_OUTPUT_TOKENS,
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
            _ => messages.push(json!({
                "role": "user",
                "content": anthropic_content(message.get("content"))
            })),
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
    if let Some(last) = messages
        .last_mut()
        .filter(|value| value.get("role").and_then(Value::as_str) == Some("user"))
    {
        if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
            content.push(block);
            return;
        }
    }
    messages.push(json!({"role": "user", "content": [block]}));
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
    let data = url.strip_prefix("data:")?;
    let (media_type, encoded) = data.split_once(";base64,")?;
    Some(json!({
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": encoded}
    }))
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
                    return None;
                }
            }
        }
    })
}

impl<S> AnthropicStreamState<S> {
    fn handle_block(&mut self, block: &str) {
        for data in block.lines().filter_map(|line| line.strip_prefix("data:")) {
            let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
                continue;
            };
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

fn take_sse_block(buffer: &mut String) -> Option<String> {
    let index = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n"))?;
    let delimiter = if buffer[index..].starts_with("\r\n\r\n") {
        4
    } else {
        2
    };
    let block = buffer[..index].to_owned();
    buffer.drain(..index + delimiter);
    Some(block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn converts_history_tools_and_results() {
        let input = json!({
            "model": "kimi-for-coding",
            "instructions": "Be concise",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Edit"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch"}],
            "stream": true
        });
        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
        assert_eq!(converted["system"], "Be concise");
        assert_eq!(converted["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(
            converted["messages"][2]["content"][0]["type"],
            "tool_result"
        );
        assert_eq!(converted["tools"][0]["name"], "apply_patch");
    }

    #[test]
    fn keeps_assistant_text_and_tool_use_in_one_anthropic_message() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "/workspace"}
            ],
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        });

        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "text");
        assert_eq!(messages[1]["content"][0]["text"], "I will inspect it.");
        assert_eq!(messages[1]["content"][1]["type"], "tool_use");
        assert_eq!(messages[1]["content"][1]["name"], "exec_command");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert!(!messages
            .windows(2)
            .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
    }

    #[test]
    fn preserves_structured_app_tool_results_for_anthropic_messages() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "namespace": "wegent_apps",
                    "name": "wegent-sites__get_site",
                    "arguments": "{\"project_id\":\"prj_1\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": {
                        "_meta": null,
                        "content": [{
                            "type": "text",
                            "text": "Wegent Sites tool completed successfully."
                        }],
                        "structuredContent": {
                            "id": "prj_1",
                            "title": "Palette"
                        }
                    }
                }
            ],
            "tools": [{
                "type": "namespace",
                "name": "wegent_apps",
                "tools": [{
                    "type": "function",
                    "name": "wegent-sites__get_site",
                    "parameters": {"type": "object"}
                }]
            }]
        });

        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

        assert_eq!(
            converted["messages"][1]["content"][0]["content"],
            "{\"id\":\"prj_1\",\"title\":\"Palette\"}"
        );
    }

    #[test]
    fn flattens_namespace_tools_for_anthropic_messages() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [{"role": "user", "content": "Inspect the page"}],
            "tools": [{
                "type": "namespace",
                "name": "wework_browser",
                "tools": [{
                    "type": "function",
                    "name": "browser_snapshot",
                    "description": "Capture the page",
                    "parameters": {"type": "object", "properties": {}}
                }]
            }]
        });

        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

        assert_eq!(converted["tools"].as_array().unwrap().len(), 1);
        assert_eq!(converted["tools"][0]["name"], "browser_snapshot");
        assert_eq!(converted["tools"][0]["description"], "Capture the page");
        assert_eq!(
            converted["tools"][0]["input_schema"],
            json!({"type": "object", "properties": {}})
        );
    }

    #[test]
    fn bridges_tool_search_and_history_for_anthropic_messages() {
        let input = json!({
            "model": "third-party-anthropic-model",
            "input": [
                {"role": "user", "content": "Find the GitHub App"},
                {
                    "type": "tool_search_call",
                    "call_id": "search_1",
                    "execution": "client",
                    "arguments": {"query": "GitHub"}
                },
                {
                    "type": "tool_search_output",
                    "call_id": "search_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": [{
                        "type": "namespace",
                        "name": "github",
                        "tools": [{
                            "type": "function",
                            "name": "create_issue",
                            "description": "Create an issue",
                            "parameters": {
                                "type": "object",
                                "properties": {"title": {"type": "string"}}
                            }
                        }]
                    }]
                }
            ],
            "tools": [{
                "type": "tool_search",
                "execution": "client",
                "description": "Search available Apps",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }]
        });

        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

        assert_eq!(converted["tools"][0]["name"], "tool_search");
        assert_eq!(converted["tools"][1]["name"], "create_issue");
        assert_eq!(
            converted["tools"][0]["input_schema"]["required"],
            json!(["query"])
        );
        assert_eq!(converted["messages"][1]["role"], "assistant");
        assert_eq!(converted["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(
            converted["messages"][1]["content"][0]["name"],
            "tool_search"
        );
        assert_eq!(
            converted["messages"][1]["content"][0]["input"],
            json!({"query": "GitHub"})
        );
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(
            converted["messages"][2]["content"][0]["type"],
            "tool_result"
        );
        assert!(converted["messages"][2]["content"][0]["content"]
            .as_str()
            .is_some_and(|value| value.contains("\"tools\"")));
    }

    #[test]
    fn preserves_friendly_apply_patch_failure_guidance() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "apply_patch verification failed: Invalid Add File Line: raw text"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch"}]
        });

        let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
        let output = converted["messages"][1]["content"][0]["content"]
            .as_str()
            .expect("tool result should contain text");

        assert!(output.contains("every file-content line must start with `+`"));
        assert!(output.contains("Correct new-file example:"));
        assert!(output.contains("call `apply_patch` again"));
    }

    #[test]
    fn converts_anthropic_cached_usage_to_full_chat_prompt_usage() {
        let response = json!({
            "id": "msg_1",
            "model": "kimi-for-coding",
            "content": [{"type": "text", "text": "Done"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 20,
                "output_tokens": 7
            }
        });

        let converted = anthropic_response_to_chat(&response);

        assert_eq!(converted["usage"]["prompt_tokens"], json!(120));
        assert_eq!(
            converted["usage"]["prompt_tokens_details"]["cached_tokens"],
            json!(90)
        );
        assert_eq!(converted["usage"]["completion_tokens"], json!(7));
    }

    #[tokio::test]
    async fn converts_anthropic_text_and_tool_stream() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{
                "input_tokens":10,
                "cache_read_input_tokens":90,
                "cache_creation_input_tokens":20
            }}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_1","name":"apply_patch","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"patch\"}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}),
        ];
        let source = futures_util::stream::iter(
            events
                .into_iter()
                .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
        );
        let output = anthropic_sse_to_responses(source, {
            let input = json!({"tools": [{"type": "custom", "name": "apply_patch"}]});
            chat::responses_to_chat_for_anthropic(&input)
                .expect("context should build")
                .1
        })
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();
        assert!(output.contains("response.reasoning_summary_text.delta"));
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("response.custom_tool_call_input.done"));
        assert!(output.contains("\"input_tokens\":120"));
        assert!(output.contains("\"cached_tokens\":90"));
    }

    #[tokio::test]
    async fn preserves_utf8_text_split_across_upstream_chunks() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"实现成本主要在 UI。"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        ];
        let payload = events
            .into_iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>()
            .into_bytes();
        let target = "在".as_bytes();
        let target_offset = payload
            .windows(target.len())
            .position(|window| window == target)
            .expect("payload should contain the target character");
        let chunks = vec![
            payload[..target_offset + 1].to_vec(),
            payload[target_offset + 1..target_offset + 2].to_vec(),
            payload[target_offset + 2..].to_vec(),
        ];
        let source = futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|chunk| Ok::<_, std::io::Error>(Bytes::from(chunk))),
        );

        let output = anthropic_sse_to_responses(source, ToolContext::default())
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| {
                String::from_utf8(bytes.to_vec()).expect("converted stream should be UTF-8")
            })
            .collect::<String>();

        assert!(output.contains("实现成本主要在 UI。"));
        assert!(!output.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn fails_when_anthropic_reports_tokens_without_output() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-k2.5","usage":{"input_tokens":1}}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":157}}),
            json!({"type":"message_stop"}),
        ];
        let source = futures_util::stream::iter(
            events
                .into_iter()
                .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
        );

        let output = anthropic_sse_to_responses(source, ToolContext::default())
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>();

        assert!(output.contains("response.failed"));
        assert!(output.contains("reported output tokens without returning content"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn completes_zero_token_anthropic_response_without_output() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-k2.5","usage":{"input_tokens":1}}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}),
            json!({"type":"message_stop"}),
        ];
        let source = futures_util::stream::iter(
            events
                .into_iter()
                .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
        );

        let output = anthropic_sse_to_responses(source, ToolContext::default())
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>();

        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn restores_namespace_on_anthropic_tool_calls() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"browser_snapshot","input":{}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
        ];
        let source = futures_util::stream::iter(
            events
                .into_iter()
                .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
        );
        let input = json!({
            "tools": [{
                "type": "namespace",
                "name": "wework_browser",
                "tools": [{
                    "type": "function",
                    "name": "browser_snapshot",
                    "parameters": {"type": "object"}
                }]
            }]
        });
        let context = chat::responses_to_chat_for_anthropic(&input)
            .expect("context should build")
            .1;
        let output = anthropic_sse_to_responses(source, context)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>();

        assert!(output.contains("\"name\":\"browser_snapshot\""));
        assert!(output.contains("\"namespace\":\"wework_browser\""));
    }

    #[test]
    fn maps_anthropic_tool_stop_reason_to_tool_calls() {
        assert_eq!(anthropic_finish_reason("tool_use"), "tool_calls");
        assert_eq!(anthropic_finish_reason("max_tokens"), "length");
        assert_eq!(anthropic_finish_reason("end_turn"), "stop");
    }

    #[tokio::test]
    async fn normalizes_anthropic_apply_patch_alias_and_fence() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"apply_patch","input":{}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"content\":\"```patch\\n*** Update File: a.txt\\n@@\\n-old\\n+new\\n```\"}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
        ];
        let source = futures_util::stream::iter(
            events
                .into_iter()
                .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
        );
        let output = anthropic_sse_to_responses(source, {
            let input = json!({"tools": [{"type": "custom", "name": "apply_patch"}]});
            chat::responses_to_chat_for_anthropic(&input)
                .expect("context")
                .1
        })
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();

        assert!(output.contains("*** Begin Patch\\n*** Update File: a.txt"));
        assert!(output.contains("+new\\n*** End Patch"));
        assert!(!output.contains("```patch"));
    }
}
