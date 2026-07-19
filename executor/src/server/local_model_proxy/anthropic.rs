// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses to Anthropic Messages compatibility for Codex.

use std::{collections::VecDeque, pin::Pin};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

use super::chat::{self, ToolContext};

pub(super) fn responses_to_anthropic(body: &Value) -> Result<(Value, ToolContext), String> {
    let (chat_body, context) = chat::responses_to_chat(body)?;
    let mut result = Map::new();
    if let Some(model) = chat_body.get("model") {
        result.insert("model".to_owned(), model.clone());
    }
    result.insert(
        "max_tokens".to_owned(),
        chat_body
            .get("max_tokens")
            .cloned()
            .unwrap_or_else(|| Value::from(4096)),
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
    output: VecDeque<Result<Bytes, std::io::Error>>,
    response_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
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
        output: VecDeque::new(),
        response_id: "msg_wework_anthropic".to_owned(),
        model: String::new(),
        input_tokens: 0,
        output_tokens: 0,
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
    json!({
        "id": response.get("id").cloned().unwrap_or_else(|| json!("msg_wework_anthropic")),
        "model": response.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{
            "message": message,
            "finish_reason": if stop_reason == "max_tokens" { "length" } else if stop_reason == "tool_use" { "tool_calls" } else { "stop" }
        }],
        "usage": {
            "prompt_tokens": response.pointer("/usage/input_tokens").cloned().unwrap_or_else(|| json!(0)),
            "completion_tokens": response.pointer("/usage/output_tokens").cloned().unwrap_or_else(|| json!(0))
        }
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
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(block) = take_sse_block(&mut state.pending) {
                        state.handle_block(&block);
                    }
                }
                Some(Err(error)) => {
                    return Some((Err(std::io::Error::other(error.to_string())), state));
                }
                None => return None,
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
                self.emit(json!({"choices": [{"delta": {}}]}));
            }
            Some("content_block_start") => self.start_content_block(event),
            Some("content_block_delta") => self.content_delta(event),
            Some("message_delta") => {
                self.output_tokens = event
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.output_tokens);
                let stop = event
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(|value| {
                        if value == "max_tokens" {
                            "length"
                        } else {
                            "stop"
                        }
                    });
                self.emit(json!({
                    "choices": [{"delta": {}, "finish_reason": stop}],
                    "usage": {"prompt_tokens": self.input_tokens, "completion_tokens": self.output_tokens}
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
            Some("text_delta") => json!({"content": delta.get("text")}),
            Some("thinking_delta") => json!({"reasoning_content": delta.get("thinking")}),
            Some("input_json_delta") => json!({"tool_calls": [{
                "index": index,
                "function": {"arguments": delta.get("partial_json")}
            }]}),
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

    #[tokio::test]
    async fn converts_anthropic_text_and_tool_stream() {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":10}}}),
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
            chat::responses_to_chat(&input)
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
        assert!(output.contains("\"input_tokens\":10"));
    }
}
