// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `create_streaming_response`'s response-side state machine: turns the
//! `raw_chat_stream` chunks into OpenAI Responses SSE frames.
use std::collections::{BTreeMap, HashMap, VecDeque};

use brz_http_server::Bytes;
use serde_json::{Map, Value, json};

use super::super::streaming::format_sse_event;

/// One reasoning summary segment (`create_streaming_response`).
pub(super) struct ReasoningSegment {
    output_index: usize,
    item_id: String,
    content: String,
}

/// The `StreamingChunk` kinds `raw_chat_stream` produces.
pub(super) enum Chunk {
    Text(String),
    Reasoning(String),
    BlockCreated(Value),
    BlockUpdated {
        block_id: String,
        updates: Value,
    },
    FunctionCallAdded {
        call_id: String,
        name: String,
        arguments: String,
    },
    FunctionCallDone {
        call_id: String,
        name: String,
        arguments: String,
    },
    ShellCallAdded {
        call_id: String,
        name: String,
        arguments: Value,
    },
    ShellCallDone {
        call_id: String,
        name: String,
        arguments: Value,
        status: String,
    },
    McpCallAdded {
        item_id: String,
        name: String,
        server_label: String,
    },
    McpCallDone {
        item_id: String,
        name: String,
        server_label: String,
        arguments: String,
        output: Option<Value>,
        status: String,
        error: Option<String>,
    },
}

/// `create_streaming_response`'s response-side state machine.
pub(super) struct ResponseState {
    response_id: String,
    model: String,
    created_at: i64,
    previous_response_id: Option<String>,
    sequence_number: i64,
    message_id: String,
    accumulated_text: String,
    message_started: bool,
    message_output_index: Option<usize>,
    next_output_index: usize,
    reasoning_segments: Vec<ReasoningSegment>,
    current_reasoning: Option<usize>,
    /// `streaming.py:204-213`'s tool output indexes, keyed by protocol + id:
    /// a producer-side classification change at TOOL_RESULT (the exec-name
    /// fallback) legitimately allocates the new protocol's index.
    tool_output_indexes: HashMap<String, usize>,
    completed_output_items: BTreeMap<usize, Value>,
    response_blocks: Map<String, Value>,
}

impl ResponseState {
    pub(super) fn new(
        response_id: String,
        model: String,
        created_at: i64,
        previous: Option<String>,
    ) -> Self {
        Self {
            response_id,
            model,
            created_at,
            previous_response_id: previous,
            sequence_number: 2,
            message_id: message_id(),
            accumulated_text: String::new(),
            message_started: false,
            message_output_index: None,
            next_output_index: 0,
            reasoning_segments: Vec::new(),
            current_reasoning: None,
            tool_output_indexes: HashMap::new(),
            completed_output_items: BTreeMap::new(),
            response_blocks: Map::new(),
        }
    }

    fn allocate_output_index(&mut self) -> usize {
        let assigned = self.next_output_index;
        self.next_output_index += 1;
        assigned
    }

    fn tool_output_index(&mut self, key: &str) -> usize {
        if let Some(index) = self.tool_output_indexes.get(key) {
            return *index;
        }
        let index = self.allocate_output_index();
        self.tool_output_indexes.insert(key.to_string(), index);
        index
    }

    fn pop_tool_output_index(&mut self, key: &str) -> usize {
        self.tool_output_indexes
            .remove(key)
            .unwrap_or_else(|| self.allocate_output_index())
    }

    fn ensure_reasoning(&mut self) -> (usize, bool) {
        if let Some(index) = self.current_reasoning {
            return (index, false);
        }
        let segment = ReasoningSegment {
            output_index: self.allocate_output_index(),
            item_id: message_id(),
            content: String::new(),
        };
        let index = self.reasoning_segments.len();
        self.reasoning_segments.push(segment);
        self.current_reasoning = Some(index);
        (index, true)
    }

    fn close_reasoning(&mut self) {
        self.current_reasoning = None;
    }

    /// Append one SSE frame with the source's dict key order; `fields` lists
    /// every key in the order `json.dumps` renders it.
    fn emit(&mut self, queue: &mut VecDeque<Bytes>, fields: Vec<(&str, Value)>) {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert(key.to_string(), value);
        }
        queue.push_back(Bytes::from(format_sse_event(&Value::Object(map))));
        self.sequence_number += 1;
    }

    fn sequence(&self) -> Value {
        json!(self.sequence_number)
    }

    pub(super) fn handle_chunk(&mut self, queue: &mut VecDeque<Bytes>, chunk: Chunk) {
        match chunk {
            Chunk::Text(content) => self.text(queue, &content),
            Chunk::Reasoning(content) => self.reasoning(queue, &content),
            Chunk::BlockCreated(block) => self.block_created(queue, block),
            Chunk::BlockUpdated { block_id, updates } => {
                self.block_updated(queue, &block_id, updates);
            }
            Chunk::FunctionCallAdded {
                call_id,
                name,
                arguments,
            } => {
                self.close_reasoning();
                let index = self.tool_output_index(&format!("function:{call_id}"));
                let item = json!({
                    "type": "function_call",
                    "id": call_id,
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                });
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.added")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", item),
                    ],
                );
            }
            Chunk::FunctionCallDone {
                call_id,
                name,
                arguments,
            } => {
                self.close_reasoning();
                let index = self.pop_tool_output_index(&format!("function:{call_id}"));
                let item = json!({
                    "type": "function_call",
                    "id": call_id,
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                });
                self.completed_output_items.insert(index, item.clone());
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.function_call_arguments.done")),
                        ("response_id", json!(self.response_id)),
                        ("item_id", json!(call_id)),
                        ("call_id", json!(call_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("arguments", json!(arguments)),
                    ],
                );
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.done")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", item),
                    ],
                );
            }
            Chunk::ShellCallAdded {
                call_id,
                name,
                arguments,
            } => {
                self.close_reasoning();
                let index = self.tool_output_index(&format!("shell:{call_id}"));
                let item = shell_call_item(&call_id, &name, &arguments, "in_progress");
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.added")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", item),
                    ],
                );
            }
            Chunk::ShellCallDone {
                call_id,
                name,
                arguments,
                status,
            } => {
                self.close_reasoning();
                let index = self.pop_tool_output_index(&format!("shell:{call_id}"));
                let item = shell_call_item(&call_id, &name, &arguments, &status);
                self.completed_output_items.insert(index, item.clone());
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.done")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", item),
                    ],
                );
            }
            Chunk::McpCallAdded {
                item_id,
                name,
                server_label,
            } => {
                self.close_reasoning();
                let index = self.tool_output_index(&format!("mcp:{item_id}"));
                let item = json!({
                    "type": "mcp_call",
                    "id": item_id,
                    "name": name,
                    "server_label": server_label,
                    "arguments": "",
                });
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.added")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", item),
                    ],
                );
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.mcp_call.in_progress")),
                        ("response_id", json!(self.response_id)),
                        ("item_id", json!(item_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                    ],
                );
            }
            Chunk::McpCallDone {
                item_id,
                name,
                server_label,
                arguments,
                output,
                status,
                error,
            } => {
                self.close_reasoning();
                let index = self.pop_tool_output_index(&format!("mcp:{item_id}"));
                let failed = status == "failed";
                let mut item = Map::new();
                item.insert("type".into(), json!("mcp_call"));
                item.insert("id".into(), json!(item_id));
                item.insert("name".into(), json!(name));
                item.insert("server_label".into(), json!(server_label));
                item.insert("arguments".into(), json!(arguments));
                item.insert(
                    "status".into(),
                    json!(if failed { "failed" } else { "completed" }),
                );
                let mut completed = item.clone();
                if let Some(output) = &output {
                    completed.insert("output".into(), output.clone());
                }
                self.completed_output_items
                    .insert(index, Value::Object(completed));
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.mcp_call_arguments.done")),
                        ("response_id", json!(self.response_id)),
                        ("item_id", json!(item_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("arguments", json!(arguments)),
                    ],
                );
                let mut fields = vec![
                    (
                        "type",
                        json!(if failed {
                            "response.mcp_call.failed"
                        } else {
                            "response.mcp_call.completed"
                        }),
                    ),
                    ("response_id", json!(self.response_id)),
                    ("item_id", json!(item_id)),
                    ("output_index", json!(index)),
                    ("sequence_number", self.sequence()),
                ];
                if failed && let Some(error) = error {
                    fields.push(("failure_reason", json!(error)));
                }
                if let Some(output) = output {
                    fields.push(("output", output));
                }
                self.emit(queue, fields);
                self.emit(
                    queue,
                    vec![
                        ("type", json!("response.output_item.done")),
                        ("response_id", json!(self.response_id)),
                        ("output_index", json!(index)),
                        ("sequence_number", self.sequence()),
                        ("item", Value::Object(item)),
                    ],
                );
            }
        }
    }

    fn text(&mut self, queue: &mut VecDeque<Bytes>, content: &str) {
        if content.is_empty() {
            return;
        }
        self.close_reasoning();
        self.accumulated_text.push_str(content);
        if !self.message_started {
            self.message_started = true;
            let index = self.allocate_output_index();
            self.message_output_index = Some(index);
            let item = json!({
                "content": [],
                "id": self.message_id,
                "role": "assistant",
                "status": "in_progress",
                "type": "message",
            });
            self.emit(
                queue,
                vec![
                    ("item", item),
                    ("output_index", json!(index)),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.output_item.added")),
                ],
            );
            let part = json!({"annotations": [], "text": "", "type": "output_text"});
            self.emit(
                queue,
                vec![
                    ("content_index", json!(0)),
                    ("item_id", json!(self.message_id)),
                    ("output_index", json!(index)),
                    ("part", part),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.content_part.added")),
                ],
            );
        }
        self.emit(
            queue,
            vec![
                ("content_index", json!(0)),
                ("delta", json!(content)),
                ("item_id", json!(self.message_id)),
                ("output_index", json!(self.message_output_index)),
                ("sequence_number", self.sequence()),
                ("type", json!("response.output_text.delta")),
            ],
        );
    }

    fn reasoning(&mut self, queue: &mut VecDeque<Bytes>, content: &str) {
        let (segment_index, created) = self.ensure_reasoning();
        let output_index = self.reasoning_segments[segment_index].output_index;
        let item_id = self.reasoning_segments[segment_index].item_id.clone();
        if created {
            let item = json!({
                "id": item_id,
                "object": "response.output_item",
                "status": "in_progress",
                "summary": [],
                "type": "reasoning",
            });
            self.emit(
                queue,
                vec![
                    ("item", item),
                    ("output_index", json!(output_index)),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.reasoning_summary_part.added")),
                ],
            );
        }
        if !content.is_empty() {
            self.reasoning_segments[segment_index]
                .content
                .push_str(content);
            self.emit(
                queue,
                vec![
                    ("content_index", json!(0)),
                    ("delta", json!(content)),
                    ("item_id", json!(item_id)),
                    ("output_index", json!(output_index)),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.reasoning_summary_text.delta")),
                ],
            );
        }
    }

    fn block_created(&mut self, queue: &mut VecDeque<Bytes>, block: Value) {
        let Some(block_id) = block.get("id").and_then(Value::as_str) else {
            return;
        };
        self.close_reasoning();
        self.response_blocks
            .insert(block_id.to_string(), block.clone());
        self.emit(
            queue,
            vec![
                ("type", json!("response.block.created")),
                ("response_id", json!(self.response_id)),
                ("sequence_number", self.sequence()),
                ("block", block),
            ],
        );
    }

    fn block_updated(&mut self, queue: &mut VecDeque<Bytes>, block_id: &str, updates: Value) {
        self.close_reasoning();
        if let Some(existing) = self.response_blocks.get_mut(block_id)
            && let (Some(existing), Some(updates)) = (existing.as_object_mut(), updates.as_object())
        {
            for (key, value) in updates {
                existing.insert(key.clone(), value.clone());
            }
        }
        self.emit(
            queue,
            vec![
                ("type", json!("response.block.updated")),
                ("response_id", json!(self.response_id)),
                ("sequence_number", self.sequence()),
                ("block_id", json!(block_id)),
                ("updates", updates),
            ],
        );
    }

    /// `_build_result_block_streaming_chunks`: result blocks not yet known
    /// become `block_created`; known blocks become `block_updated`.
    pub(super) fn result_blocks(&mut self, queue: &mut VecDeque<Bytes>, result: Option<&Value>) {
        let Some(blocks) = result
            .and_then(|result| result.get("blocks"))
            .and_then(Value::as_array)
        else {
            return;
        };
        for block in blocks {
            let Some(block_id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            if self.response_blocks.contains_key(block_id) {
                let updates = block
                    .as_object()
                    .map(|map| {
                        Value::Object(
                            map.iter()
                                .filter(|(key, _)| key.as_str() != "id")
                                .map(|(key, value)| (key.clone(), value.clone()))
                                .collect(),
                        )
                    })
                    .unwrap_or(Value::Null);
                self.block_updated(queue, block_id, updates);
            } else {
                self.block_created(queue, block.clone());
            }
        }
    }

    /// Close the text output item and emit `response.completed`/`failed`.
    pub(super) fn finish(
        &mut self,
        queue: &mut VecDeque<Bytes>,
        status: &str,
        error: Option<Value>,
    ) {
        if status == "failed" {
            let mut response = self.base_response("failed");
            if let Some(error) = error {
                response.insert("error".into(), error);
            }
            if !self.accumulated_text.is_empty() {
                response.insert(
                    "output".into(),
                    json!([{
                        "type": "message",
                        "id": self.message_id,
                        "status": "incomplete",
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": self.accumulated_text,
                            "annotations": [],
                        }],
                    }]),
                );
            }
            self.emit(
                queue,
                vec![
                    ("response", Value::Object(response)),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.failed")),
                ],
            );
            return;
        }

        if !self.accumulated_text.is_empty() {
            self.emit(
                queue,
                vec![
                    ("content_index", json!(0)),
                    ("item_id", json!(self.message_id)),
                    ("output_index", json!(self.message_output_index)),
                    ("sequence_number", self.sequence()),
                    ("text", json!(self.accumulated_text)),
                    ("type", json!("response.output_text.done")),
                ],
            );
            let part = json!({
                "annotations": [],
                "text": self.accumulated_text,
                "type": "output_text",
            });
            self.emit(
                queue,
                vec![
                    ("content_index", json!(0)),
                    ("item_id", json!(self.message_id)),
                    ("output_index", json!(self.message_output_index)),
                    ("part", part),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.content_part.done")),
                ],
            );
            let item = json!({
                "content": [{
                    "annotations": [],
                    "text": self.accumulated_text,
                    "type": "output_text",
                }],
                "id": self.message_id,
                "role": "assistant",
                "status": "completed",
                "type": "message",
            });
            self.emit(
                queue,
                vec![
                    ("item", item),
                    ("output_index", json!(self.message_output_index)),
                    ("sequence_number", self.sequence()),
                    ("type", json!("response.output_item.done")),
                ],
            );
        }

        let mut output: BTreeMap<usize, Value> = self.completed_output_items.clone();
        for segment in &self.reasoning_segments {
            if segment.content.is_empty() {
                continue;
            }
            output.insert(
                segment.output_index,
                json!({
                    "type": "message",
                    "id": segment.item_id,
                    "status": "completed",
                    "role": "assistant",
                    "content": [{
                        "type": "reasoning",
                        "text": segment.content,
                        "annotations": [],
                    }],
                }),
            );
        }
        if !self.accumulated_text.is_empty()
            && let Some(index) = self.message_output_index
        {
            output.insert(
                index,
                json!({
                    "type": "message",
                    "id": self.message_id,
                    "status": "completed",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": self.accumulated_text,
                        "annotations": [],
                    }],
                }),
            );
        }

        let mut response = self.base_response("completed");
        response.insert(
            "output".into(),
            Value::Array(output.into_values().collect()),
        );
        if !self.response_blocks.is_empty() {
            response.insert(
                "blocks".into(),
                Value::Array(self.response_blocks.values().cloned().collect()),
            );
        }
        self.emit(
            queue,
            vec![
                ("response", Value::Object(response)),
                ("sequence_number", self.sequence()),
                ("type", json!("response.completed")),
            ],
        );
    }

    fn base_response(&self, status: &str) -> Map<String, Value> {
        let mut response = Map::new();
        response.insert("id".into(), json!(self.response_id));
        response.insert("object".into(), json!("response"));
        response.insert("created_at".into(), json!(self.created_at));
        response.insert("status".into(), json!(status));
        response.insert("error".into(), Value::Null);
        response.insert("model".into(), json!(self.model));
        response.insert("output".into(), json!([]));
        response.insert("pending_user_input".into(), Value::Null);
        response.insert("pending_user_input_payload".into(), Value::Null);
        response.insert(
            "previous_response_id".into(),
            json!(self.previous_response_id),
        );
        response
    }
}

/// `_build_shell_call_item`.
fn shell_call_item(call_id: &str, name: &str, arguments: &Value, status: &str) -> Value {
    let mut action = Map::new();
    let commands = arguments
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty())
        .map(|command| json!([command]))
        .unwrap_or_else(|| json!([]));
    action.insert("commands".into(), commands);
    if let Some(timeout) = arguments.get("timeout_seconds").and_then(Value::as_i64)
        && timeout > 0
    {
        action.insert("timeout_ms".into(), json!(timeout * 1000));
    }
    json!({
        "type": "shell_call",
        "id": call_id,
        "call_id": call_id,
        "status": status,
        "action": Value::Object(action),
        "name": name,
        "input": arguments,
    })
}

/// `_generate_message_id`: `msg_{uuid4().hex[:12]}`.
pub(super) fn message_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    let mut hex = String::with_capacity(16);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("msg_{}", &hex[..12])
}

#[cfg(test)]
mod tests {
    use super::super::super::streaming::framing_events;
    use super::*;

    fn event_types(queue: &VecDeque<Bytes>) -> Vec<String> {
        queue
            .iter()
            .map(|bytes| {
                let text = std::str::from_utf8(bytes).expect("utf8");
                let rest = text.strip_prefix("data: ").expect("data prefix");
                let rest = rest.strip_suffix("\n\n").expect("frame suffix");
                let value: Value = serde_json::from_str(rest).expect("json");
                value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    /// The recorded `df5d766e` shape: two framing events, the first text item,
    /// the deltas, the terminal result block, the close events and the final
    /// completed event.
    #[test]
    fn text_stream_matches_the_source_event_sequence() {
        let mut state = ResponseState::new("resp_1".into(), "m".into(), 1_792_479_719, None);
        let mut queue = VecDeque::new();
        for event in framing_events(1, 1_792_479_719, "m", None) {
            queue.push_back(event);
        }
        state.handle_chunk(&mut queue, Chunk::Text("he".into()));
        state.handle_chunk(&mut queue, Chunk::Text("llo".into()));
        state.result_blocks(
            &mut queue,
            Some(&json!({"blocks": [{"id": "b1", "type": "text"}]})),
        );
        state.finish(&mut queue, "completed", None);
        assert_eq!(
            event_types(&queue),
            [
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.block.created",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed",
            ]
        );
        let last = std::str::from_utf8(queue.back().unwrap())
            .unwrap()
            .to_string();
        assert!(last.contains("\"text\": \"hello\""));
        assert!(last.contains("\"blocks\": [{\"id\": \"b1\", \"type\": \"text\"}]"));
    }

    #[test]
    fn missing_result_blocks_emit_no_block_frames() {
        // An empty or failed block read leaves the collected result without a
        // `blocks` member; the source then emits no `response.block.created`
        // frame and the completed event carries no `blocks`.
        let mut state = ResponseState::new("resp_1".into(), "m".into(), 1_792_479_719, None);
        let mut queue = VecDeque::new();
        for event in framing_events(1, 1_792_479_719, "m", None) {
            queue.push_back(event);
        }
        state.handle_chunk(&mut queue, Chunk::Text("hello".into()));
        state.result_blocks(&mut queue, Some(&json!({"value": "hello"})));
        state.result_blocks(&mut queue, None);
        state.finish(&mut queue, "completed", None);
        let types = event_types(&queue);
        assert!(
            !types.iter().any(|kind| kind == "response.block.created"),
            "{types:?}"
        );
        let last = std::str::from_utf8(queue.back().unwrap())
            .unwrap()
            .to_string();
        assert!(!last.contains("\"blocks\""), "{last}");
    }

    #[test]
    fn failed_stream_emits_response_failed() {
        let mut state = ResponseState::new("resp_1".into(), "m".into(), 1, None);
        let mut queue = VecDeque::new();
        state.finish(
            &mut queue,
            "failed",
            Some(json!({"code": "stream_error", "message": "boom"})),
        );
        assert_eq!(event_types(&queue), ["response.failed"]);
    }
}
