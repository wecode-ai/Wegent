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

#[path = "tool_catalog.rs"]
mod tool_catalog;
use tool_catalog::effective_tools;

mod custom_tools;
pub(crate) use custom_tools::CustomToolConversion;

const CUSTOM_TOOL_INPUT_FIELD: &str = "input";
const TOOL_SEARCH_NAME: &str = "tool_search";
pub(super) const BRIDGED_TOOL_SEARCH_NAME: &str = "search_deferred_tools";
const TOOL_SEARCH_DESCRIPTION: &str = "Search deferred MCP and App tools by capability. Call this before concluding that a requested tool is unavailable.";
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
    ToolSearch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolIdentity {
    name: String,
    namespace: Option<String>,
    kind: ToolKind,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ToolContext {
    tools: BTreeMap<String, ToolIdentity>,
    wire_names: BTreeMap<(Option<String>, String), String>,
}

impl ToolContext {
    fn insert_tool(&mut self, wire_name: String, identity: ToolIdentity) {
        self.wire_names
            .entry((identity.namespace.clone(), identity.name.clone()))
            .or_insert_with(|| wire_name.clone());
        self.tools.entry(wire_name).or_insert(identity);
    }

    #[cfg(test)]
    fn insert(&mut self, name: String, kind: ToolKind) {
        self.insert_tool(
            name.clone(),
            ToolIdentity {
                name,
                namespace: None,
                kind,
            },
        );
    }

    fn is_custom(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .or_else(|| {
                self.wire_name(None, name)
                    .and_then(|wire_name| self.tools.get(wire_name))
            })
            .map(|tool| &tool.kind)
            == Some(&ToolKind::Custom)
    }

    fn identity(&self, wire_name: &str) -> Option<&ToolIdentity> {
        self.tools.get(wire_name)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    fn wire_name(&self, namespace: Option<&str>, name: &str) -> Option<&str> {
        self.wire_names
            .get(&(namespace.map(str::to_owned), name.to_owned()))
            .map(String::as_str)
    }
}

#[cfg(test)]
pub(super) fn responses_to_chat(body: &Value) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_model_hint(body, None)
}

#[derive(Debug, Default)]
struct ToolOutput {
    text: String,
    images: Vec<Value>,
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
    namespace: Option<String>,
    custom: bool,
    tool_search: bool,
    arguments: String,
}

#[derive(Debug)]
struct ChatStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
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

/// State kept while rewriting ordinary Responses function calls back into
/// Codex-native custom, namespace, and tool-search calls.
struct ResponsesToolState {
    context: ToolContext,
    calls: HashMap<String, ResponsesToolCallState>,
}

#[derive(Default)]
struct ResponsesToolCallState {
    identity: Option<ToolIdentity>,
    arguments: String,
    done: bool,
}

impl ResponsesToolState {
    fn bridged_identity(&self, item: &Value) -> Option<ToolIdentity> {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return None;
        }
        let name = item.get("name").and_then(Value::as_str)?;
        let identity = if let Some(namespace) = item.get("namespace").and_then(Value::as_str) {
            self.context
                .identity(self.context.wire_name(Some(namespace), name)?)?
        } else {
            self.context.identity(name)?
        };
        if identity.kind == ToolKind::Function && identity.namespace.is_none() {
            return None;
        }
        Some(identity.clone())
    }

    fn start_call(&mut self, item_id: &str, identity: ToolIdentity) {
        self.calls.entry(item_id.to_owned()).or_default().identity = Some(identity);
    }

    fn append_arguments(&mut self, item_id: &str, delta: &str) {
        if let Some(state) = self.calls.get_mut(item_id) {
            state.arguments.push_str(delta);
        }
    }

    fn finish_arguments(&mut self, item_id: &str, arguments: Option<&str>) {
        let Some(state) = self.calls.get_mut(item_id) else {
            return;
        };
        if let Some(arguments) = arguments {
            state.arguments = arguments.to_owned();
        }
        state.done = true;
    }

    fn identity(&self, item_id: &str) -> Option<&ToolIdentity> {
        self.calls.get(item_id)?.identity.as_ref()
    }

    fn arguments(&self, item_id: &str) -> Option<&str> {
        let state = self.calls.get(item_id)?;
        (!state.arguments.is_empty()).then_some(state.arguments.as_str())
    }

    fn custom_input(&self, item_id: &str) -> Option<String> {
        let state = self.calls.get(item_id)?;
        if state.arguments.is_empty() {
            return None;
        }
        extract_custom_tool_input(&state.arguments)
    }
}

struct ResponsesStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
    output: std::collections::VecDeque<Result<Bytes, std::io::Error>>,
    context_state: ResponsesToolState,
    source_done: bool,
    terminal_seen: bool,
}

impl<S> ChatStreamState<S> {
    fn emit(&mut self, event: Bytes) {
        self.output.push_back(Ok(event));
    }

    fn handle_block(&mut self, block: &str, strict: bool) {
        let Some(event) = super::sse::Event::parse(block) else {
            return;
        };
        let data = event.data.trim();
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
        if event
            .name
            .is_some_and(|value| value.eq_ignore_ascii_case("error"))
        {
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
        let (
            needs_start,
            call_id,
            complete_name,
            complete_namespace,
            custom,
            tool_search,
            matched_tool,
        ) = {
            let state = self.calls.entry(index).or_default();
            if !id.is_empty() {
                state.call_id = super::normalized_responses_api_id(id);
            }
            let mut matched_tool = false;
            if !name.is_empty() {
                if let Some(identity) = self.context.identity(name) {
                    state.name = identity.name.clone();
                    state.namespace = identity.namespace.clone();
                    state.custom = identity.kind == ToolKind::Custom;
                    state.tool_search = identity.kind == ToolKind::ToolSearch;
                    matched_tool = true;
                } else {
                    state.name = name.to_owned();
                    state.namespace = None;
                    state.custom = false;
                    state.tool_search = false;
                }
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
                state.namespace.clone(),
                state.custom,
                state.tool_search,
                matched_tool,
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
            let item_type = if tool_search {
                "tool_search_call"
            } else if custom {
                "custom_tool_call"
            } else {
                "function_call"
            };
            let mut item = if tool_search {
                json!({
                    "id": item_id,
                    "type": item_type,
                    "status": "in_progress",
                    "call_id": call_id,
                    "execution": "client",
                    "arguments": {}
                })
            } else if item_type == "custom_tool_call" {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name.clone(), "input": ""})
            } else {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name.clone(), "arguments": ""})
            };
            if let Some(namespace) = complete_namespace {
                item["namespace"] = Value::String(namespace);
            }
            log_executor_event(
                "local model proxy tool call started",
                &[
                    ("call_index", index.to_string()),
                    ("upstream_tool_name", name.to_owned()),
                    ("resolved_tool_name", complete_name),
                    ("matched_tool", matched_tool.to_string()),
                    (
                        "namespace",
                        item.get("namespace")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                    ("custom_tool", custom.to_string()),
                    ("tool_search", tool_search.to_string()),
                ],
            );
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
        }
        if !arguments.is_empty() {
            let (output_index, item_id, custom, tool_search) = {
                let state = self.calls.entry(index).or_default();
                (
                    state.output_index,
                    state.item_id.clone(),
                    state.custom,
                    state.tool_search,
                )
            };
            if !custom && !tool_search && !item_id.is_empty() {
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
        let tool_call_count = self.calls.values().filter(|state| state.started).count();
        log_executor_event(
            "local model proxy chat completion summary",
            &[
                ("model", self.model.clone()),
                (
                    "finish_reason",
                    self.finish_reason.clone().unwrap_or_default(),
                ),
                ("text_bytes", self.text.text.len().to_string()),
                ("reasoning_bytes", self.reasoning.text.len().to_string()),
                ("tool_calls", tool_call_count.to_string()),
                (
                    "empty_output",
                    (!self.text.started && !self.reasoning.started && tool_call_count == 0)
                        .to_string(),
                ),
            ],
        );
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
            log_executor_event(
                "local model proxy tool call completed",
                &[
                    ("tool_name", state.name.clone()),
                    ("namespace", state.namespace.clone().unwrap_or_default()),
                    ("custom_tool", state.custom.to_string()),
                    ("tool_search", state.tool_search.to_string()),
                    ("arguments_bytes", state.arguments.len().to_string()),
                ],
            );
            let custom = state.custom;
            let tool_search = state.tool_search;
            let arguments = if custom {
                custom_input(&state.name, &state.arguments)
            } else {
                normalize_arguments(&state.arguments)
            };
            let mut item = if tool_search {
                json!({
                    "id": state.item_id,
                    "type": "tool_search_call",
                    "status": "completed",
                    "call_id": state.call_id,
                    "execution": "client",
                    "arguments": serde_json::from_str::<Value>(&arguments)
                        .unwrap_or_else(|_| json!({}))
                })
            } else if custom {
                json!({"id": state.item_id, "type": "custom_tool_call", "status": "completed", "call_id": state.call_id, "name": state.name, "input": arguments})
            } else {
                json!({"id": state.item_id, "type": "function_call", "status": "completed", "call_id": state.call_id, "name": state.name, "arguments": arguments})
            };
            if let Some(namespace) = state.namespace {
                item["namespace"] = Value::String(namespace);
            }
            let done_event = if tool_search {
                None
            } else if custom {
                Some("response.custom_tool_call_input.done")
            } else {
                Some("response.function_call_arguments.done")
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
            if let Some(done_event) = done_event {
                let done_payload = if custom {
                    json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "input": arguments})
                } else {
                    json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "arguments": arguments})
                };
                self.emit(sse(done_event, done_payload));
            }
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": state.output_index, "item": item})));
            output.push((state.output_index, item));
        }
        output.sort_by_key(|(index, _)| *index);
        let incomplete = self.finish_reason.as_deref() == Some("length");
        let status = if incomplete {
            "incomplete"
        } else {
            "completed"
        };
        let event = if incomplete {
            "response.incomplete"
        } else {
            "response.completed"
        };
        let response = self.response(status, output.into_iter().map(|(_, value)| value).collect());
        self.emit(sse(event, json!({"type": event, "response": response})));
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
            "incomplete_details": if status == "incomplete" { json!({"reason": "max_output_tokens"}) } else { Value::Null }
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

#[cfg(test)]
#[path = "chat/tests/mod.rs"]
mod tests;

mod request_translation;

mod tool_schema;

mod responses_request;

mod input_translation;

mod responses_events;

mod chat_events;
use chat_events::content_delta;
use chat_events::custom_input;
use chat_events::meaningful_error_message;
#[cfg(test)]
use chat_events::normalize_apply_patch_input;
use chat_events::normalize_arguments;
use chat_events::reasoning_delta;
use chat_events::responses_usage;
use chat_events::snapshot_suffix;
use chat_events::sse;
use input_translation::append_input;
use input_translation::append_tool_image_content;
use input_translation::backfill_kimi_tool_call_reasoning;
use input_translation::collapse_system_messages;
use input_translation::flush_tool_image_content_to_responses;
pub(super) use input_translation::friendly_apply_patch_output;
use input_translation::json_string;
use input_translation::split_tool_output;
use input_translation::text_value;
use input_translation::tool_image_output_notice;
pub(super) use request_translation::responses_to_chat_for_anthropic;
pub(super) use request_translation::responses_to_chat_with_model_hint;
pub(super) use responses_events::chat_sse_to_responses;
use responses_events::extract_custom_tool_input;
pub(super) use responses_events::responses_sse_to_responses;
use responses_request::chat_tool_choice;
use responses_request::is_tool_output_item;
pub(super) use responses_request::responses_to_responses;
use tool_schema::apply_reasoning_options;
use tool_schema::bridged_tool_search_description;
use tool_schema::bridged_tool_search_parameters;
use tool_schema::build_tool_context;
use tool_schema::chat_tools;
#[cfg(test)]
use tool_schema::is_kimi_k3_model;
use tool_schema::request_uses_kimi_k3;
