// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Streaming emit pipeline for the execution callback.
//!
//! Mirrors `StatusUpdatingEmitter` + `WebSocketResultEmitter` +
//! `WebPageSocketEmitter` in `app/services/execution/emitters/`. The wrapper
//! persists streamed content and mixed-content blocks into Redis and then
//! forwards the event to the Socket.IO emitter, which publishes to the
//! `socketio` channel.
use std::time::{Duration, Instant};

use brz_redis::{Redis, RedisResult};
use serde_json::{Map, Value, json};

use super::event::ExecutionEvent;
use super::session;
use super::socketio::{publish_emit, publish_emit_in_room};

const TASK_STREAMING_ACTIVITY_TOUCH_INTERVAL: Duration = Duration::from_secs(1);

/// `STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS`: the source debounces buffered
/// stream content and flushes it one second after the first buffered piece.
const STREAMING_STORAGE_FLUSH_INTERVAL: Duration = Duration::from_secs(1);

const STREAM_BOUNDARY_EVENT_TYPES: [&str; 6] = [
    "tool_start",
    "tool_argument_delta",
    "tool_argument_done",
    "tool_result",
    "block_created",
    "block_updated",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum StreamContentType {
    Text,
    Thinking,
}

/// The wrapper that persists stream state before forwarding to Socket.IO.
///
/// The emitter owns its Redis handle so a response-body stream can retain it
/// across polls; `RedisService` clones share one pool.
pub(crate) struct StatusUpdatingEmitter<R: Redis> {
    redis: R,
    task_id: i64,
    subtask_id: i64,
    buffer: Vec<(StreamContentType, String)>,
    first_buffered_at: Option<Instant>,
    last_activity_touch: Option<Instant>,
}

impl<R: Redis> StatusUpdatingEmitter<R> {
    pub(crate) fn new(redis: R, task_id: i64, subtask_id: i64) -> Self {
        Self {
            redis,
            task_id,
            subtask_id,
            buffer: Vec::new(),
            first_buffered_at: None,
            last_activity_touch: None,
        }
    }

    fn buffer_content(&mut self, content_type: StreamContentType, content: &str) {
        if content.is_empty() {
            return;
        }
        if self.first_buffered_at.is_none() {
            self.first_buffered_at = Some(Instant::now());
        }
        match self.buffer.last_mut() {
            Some((last_type, buffered)) if *last_type == content_type => {
                buffered.push_str(content);
            }
            _ => self.buffer.push((content_type, content.to_string())),
        }
    }

    /// The instant when `_flush_stream_storage_after_delay` fires.
    ///
    /// The source arms one detached `asyncio.sleep(1.0)` task per buffered
    /// run, so the batch boundary is exactly one second after the first piece
    /// of that run. Callers must wake at this instant; checking only on an
    /// unrelated periodic tick stretches the batch and stores different
    /// `chat:streaming:*` content than the source.
    pub(crate) fn flush_deadline(&self) -> Option<Instant> {
        self.first_buffered_at
            .map(|first| first + STREAMING_STORAGE_FLUSH_INTERVAL)
    }

    /// `_flush_stream_storage_after_delay`: write the buffered content once the
    /// source's one-second debounce has elapsed.
    ///
    /// The source arms one detached `asyncio.sleep(1.0)` task per buffered run,
    /// and that task only writes the `chat:streaming:*` batch. Cancellation
    /// reads belong to the readers instead: `raw_chat_stream` reads
    /// `is_cancelled` once per consumed event, and `dispatch_sse`'s
    /// `_wait_for_sse_cancellation` poller reads it once per second. A flush
    /// tick must therefore not issue its own `GET chat:cancel:*`.
    pub(crate) async fn flush_due(&mut self) {
        self.flush_stream_storage().await;
    }

    async fn flush_stream_storage(&mut self) {
        self.first_buffered_at = None;
        let pending = std::mem::take(&mut self.buffer);
        if pending.is_empty() {
            return;
        }
        for (content_type, content) in pending {
            let result = match content_type {
                StreamContentType::Text => {
                    session::add_text_content(&self.redis, self.subtask_id, &content).await
                }
                StreamContentType::Thinking => {
                    session::add_thinking_content(&self.redis, self.subtask_id, &content).await
                }
            };
            if let Err(error) = result {
                tracing::warn!(%error, "callback stream content flush failed");
            }
        }
        self.touch_activity(true).await;
    }

    async fn touch_activity(&mut self, force: bool) {
        if !force
            && let Some(last) = self.last_activity_touch
            && last.elapsed() < TASK_STREAMING_ACTIVITY_TOUCH_INTERVAL
        {
            return;
        }
        if let Err(error) = session::touch_task_streaming_activity(&self.redis, self.task_id).await
        {
            tracing::warn!(%error, "callback streaming activity touch failed");
        }
        self.last_activity_touch = Some(Instant::now());
    }

    /// Emit one event: persist stream state, then forward to Socket.IO.
    pub(crate) async fn emit(&mut self, event: &mut ExecutionEvent) -> RedisResult<()> {
        self.persist(event).await?;

        // A terminal event's frames are emitted by the caller after the task
        // completion subsystem has run, so its `chat:done` payload carries the
        // collected result; see `mod.rs`.
        if !is_terminal(&event.event_type) {
            self.forward_to_socketio(event).await?;
        }
        Ok(())
    }

    /// Persist one event's stream state without forwarding it to Socket.IO.
    ///
    /// The chat-shell SSE dispatch wraps its emitter in
    /// `StatusUpdatingEmitter` exactly like the callback does, but its wrapped
    /// `SSEResultEmitter` writes to the caller's stream instead of publishing
    /// Socket.IO frames. The persistence half is identical.
    pub(crate) async fn emit_persist_only(
        &mut self,
        event: &mut ExecutionEvent,
    ) -> RedisResult<()> {
        self.persist(event).await
    }

    async fn persist(&mut self, event: &mut ExecutionEvent) -> RedisResult<()> {
        match event.event_type.as_str() {
            "start" => {
                session::set_task_streaming_status(
                    &self.redis,
                    self.task_id,
                    self.subtask_id,
                    0,
                    "",
                )
                .await?;
            }
            "chunk" => self.buffer_content(StreamContentType::Text, &event.content),
            "thinking" => {
                self.buffer_content(StreamContentType::Thinking, &event.content);
            }
            kind if STREAM_BOUNDARY_EVENT_TYPES.contains(&kind) => {
                self.flush_stream_storage().await;
                self.touch_activity(false).await;
            }
            _ => {}
        }

        self.collect_blocks(event).await
    }

    /// Finish the request: flush buffered stream content like `close()`.
    pub(crate) async fn close(&mut self) {
        self.flush_stream_storage().await;
    }

    async fn collect_blocks(&mut self, event: &mut ExecutionEvent) -> RedisResult<()> {
        match event.event_type.as_str() {
            "tool_start" => {
                let display_name = event.data.get("display_name").and_then(Value::as_str);
                let tool_protocol = event.data.get("tool_protocol").and_then(Value::as_str);
                let server_label = event.data.get("server_label").and_then(Value::as_str);
                session::add_tool_block(
                    &self.redis,
                    self.subtask_id,
                    event.tool_use_id.as_deref().unwrap_or_default(),
                    event.tool_name.as_deref().unwrap_or_default(),
                    event.tool_input.as_ref(),
                    display_name,
                    tool_protocol,
                    server_label,
                )
                .await?;
                if event.data.get("argument_status").and_then(Value::as_str) == Some("streaming") {
                    session::update_tool_block_status(
                        &self.redis,
                        self.subtask_id,
                        event.tool_use_id.as_deref().unwrap_or_default(),
                        Some("generating_arguments"),
                        None,
                        event.tool_input.as_ref(),
                        None,
                        None,
                        None,
                    )
                    .await?;
                }
            }
            "tool_argument_delta" => {
                if let Some(tool_use_id) = event.tool_use_id.as_deref() {
                    session::update_tool_block_status(
                        &self.redis,
                        self.subtask_id,
                        tool_use_id,
                        Some("generating_arguments"),
                        None,
                        event.tool_input.as_ref(),
                        None,
                        None,
                        None,
                    )
                    .await?;
                }
            }
            "tool_argument_done" => {
                if let Some(tool_use_id) = event.tool_use_id.as_deref() {
                    session::update_tool_block_status(
                        &self.redis,
                        self.subtask_id,
                        tool_use_id,
                        Some("pending"),
                        None,
                        event.tool_input.as_ref(),
                        None,
                        None,
                        None,
                    )
                    .await?;
                }
            }
            "tool_result" => {
                if let Some(tool_use_id) = event.tool_use_id.as_deref() {
                    let failed = matches!(
                        event.data.get("status").and_then(Value::as_str),
                        Some("failed" | "error")
                    );
                    let tool_protocol = event.data.get("tool_protocol").and_then(Value::as_str);
                    let server_label = event.data.get("server_label").and_then(Value::as_str);
                    session::update_tool_block_status(
                        &self.redis,
                        self.subtask_id,
                        tool_use_id,
                        Some(if failed { "error" } else { "done" }),
                        event.tool_output.as_ref(),
                        event.tool_input.as_ref(),
                        None,
                        tool_protocol,
                        server_label,
                    )
                    .await?;
                }
            }
            "block_created" => {
                // `add_block` mutates the same block object the source later
                // forwards to Socket.IO, so its generated id/timestamp appear
                // in the emitted payload.
                if let Some(Value::Object(block)) = event.data.get_mut("block") {
                    session::add_block(&self.redis, self.subtask_id, block).await?;
                }
            }
            "block_updated" => {
                let block_id = event.data.get("block_id").and_then(Value::as_str);
                let updates = event.data.get("updates").and_then(Value::as_object);
                if let (Some(block_id), Some(updates)) = (block_id, updates) {
                    let blocks = session::get_blocks(&self.redis, self.subtask_id).await;
                    let existing = blocks
                        .into_iter()
                        .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id));
                    let mut block = match existing {
                        Some(mut block) => {
                            for (key, value) in updates {
                                block.insert(key.clone(), value.clone());
                            }
                            block
                        }
                        None => {
                            let mut block = Map::new();
                            block.insert("id".into(), Value::String(block_id.to_string()));
                            block.insert("type".into(), Value::String("tool".into()));
                            block.insert("tool_use_id".into(), Value::String(block_id.to_string()));
                            for (key, value) in updates {
                                block.insert(key.clone(), value.clone());
                            }
                            block
                        }
                    };
                    session::add_block(&self.redis, self.subtask_id, &mut block).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// `WebSocketResultEmitter.emit` + `WebPageSocketEmitter` payloads.
    async fn forward_to_socketio(&self, event: &ExecutionEvent) -> RedisResult<()> {
        match event.event_type.as_str() {
            "start" => {
                let shell_type = event
                    .data
                    .get("shell_type")
                    .and_then(Value::as_str)
                    .unwrap_or("Chat");
                let bot_name = event.data.get("bot_name").cloned().unwrap_or(Value::Null);
                let payload = json!({
                    "task_id": event.task_id,
                    "subtask_id": event.subtask_id,
                    "bot_name": bot_name,
                    "shell_type": shell_type,
                    "message_id": event.message_id,
                });
                publish_emit(&self.redis, "chat:start", event.task_id, payload).await?;
            }
            "chunk" => {
                let payload = chunk_payload(
                    event,
                    event.content.clone(),
                    event.offset,
                    event.message_id,
                    event.data.get("block_id").and_then(Value::as_str),
                    event.data.get("block_offset").cloned(),
                    event.result.clone(),
                );
                publish_emit(&self.redis, "chat:chunk", event.task_id, payload).await?;
            }
            "thinking" => {
                let mut result = Map::new();
                result.insert(
                    "reasoning_chunk".into(),
                    Value::String(event.content.clone()),
                );
                let payload = chunk_payload(
                    event,
                    String::new(),
                    event.offset,
                    event.message_id,
                    None,
                    None,
                    Some(Value::Object(result)),
                );
                publish_emit(&self.redis, "chat:chunk", event.task_id, payload).await?;
            }
            "tool_start" => {
                let mut block = session::create_tool_block(
                    event.tool_use_id.as_deref().unwrap_or_default(),
                    event.tool_name.as_deref().unwrap_or_default(),
                    event.tool_input.as_ref(),
                    event.data.get("display_name").and_then(Value::as_str),
                    event.data.get("tool_protocol").and_then(Value::as_str),
                    event.data.get("server_label").and_then(Value::as_str),
                );
                if event.data.get("argument_status").and_then(Value::as_str) == Some("streaming") {
                    block.insert(
                        "status".into(),
                        Value::String("generating_arguments".into()),
                    );
                    block.insert("argument_status".into(), Value::String("streaming".into()));
                }
                let payload = json!({
                    "task_id": event.task_id,
                    "subtask_id": event.subtask_id,
                    "block": Value::Object(block),
                });
                publish_emit(&self.redis, "chat:block_created", event.task_id, payload).await?;
            }
            "tool_argument_delta" | "tool_argument_done" => {
                let status = if event.event_type == "tool_argument_delta" {
                    "generating_arguments"
                } else {
                    "pending"
                };
                let mut updates = Map::new();
                if let Some(tool_input) = event.tool_input.as_ref() {
                    updates.insert("tool_input".into(), tool_input.clone());
                }
                updates.insert("status".into(), Value::String(status.into()));
                let payload = block_update_payload(
                    event,
                    event.tool_use_id.as_deref().unwrap_or_default(),
                    &updates,
                );
                publish_emit(&self.redis, "chat:block_updated", event.task_id, payload).await?;
            }
            "tool_result" => {
                let status = if matches!(
                    event.data.get("status").and_then(Value::as_str),
                    Some("error" | "failed")
                ) {
                    "error"
                } else {
                    "done"
                };
                let mut updates = Map::new();
                if let Some(tool_output) = event.tool_output.as_ref() {
                    updates.insert("tool_output".into(), tool_output.clone());
                }
                if let Some(tool_input) = event.tool_input.as_ref() {
                    updates.insert("tool_input".into(), tool_input.clone());
                }
                updates.insert("status".into(), Value::String(status.into()));
                let payload = block_update_payload(
                    event,
                    event.tool_use_id.as_deref().unwrap_or_default(),
                    &updates,
                );
                publish_emit(&self.redis, "chat:block_updated", event.task_id, payload).await?;
            }
            "block_created" => {
                if let Some(block) = event.data.get("block") {
                    let payload = json!({
                        "task_id": event.task_id,
                        "subtask_id": event.subtask_id,
                        "block": block.clone(),
                    });
                    publish_emit(&self.redis, "chat:block_created", event.task_id, payload).await?;
                }
            }
            "block_updated" => {
                let block_id = event
                    .data
                    .get("block_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let updates = event.data.get("updates").and_then(Value::as_object);
                if let Some(updates) = updates {
                    let payload = block_update_payload(event, block_id, updates);
                    publish_emit(&self.redis, "chat:block_updated", event.task_id, payload).await?;
                }
            }
            "status_updated" => {
                let phase = event.data.get("phase").cloned().unwrap_or(Value::Null);
                let context_metrics = event
                    .data
                    .get("context_metrics")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let context_compaction = event
                    .data
                    .get("context_compaction")
                    .cloned()
                    .unwrap_or(Value::Null);
                let snapshot = json!({
                    "task_id": event.task_id,
                    "subtask_id": event.subtask_id,
                    "phase": phase,
                    "context_metrics": context_metrics,
                    "context_compaction": context_compaction,
                });
                session::save_context_metrics(&self.redis, event.subtask_id, &snapshot).await?;
                let mut payload = Map::new();
                payload.insert("task_id".into(), json!(event.task_id));
                payload.insert("subtask_id".into(), json!(event.subtask_id));
                payload.insert("phase".into(), phase);
                payload.insert("context_metrics".into(), context_metrics);
                if !context_compaction.is_null() {
                    payload.insert("context_compaction".into(), context_compaction);
                }
                publish_emit(
                    &self.redis,
                    "chat:status_updated",
                    event.task_id,
                    Value::Object(payload),
                )
                .await?;
            }
            _ => {}
        }
        Ok(())
    }
}

fn is_terminal(event_type: &str) -> bool {
    matches!(event_type, "done" | "error" | "cancelled")
}

/// `WebSocketResultEmitter.emit`'s terminal branch
/// (`app/services/execution/emitters/websocket.py:157-169`): the `chat:done`
/// result frame for `task:{task_id}`, then the `task:status` frame for the
/// owner's `user:{user_id}` room.
///
/// The caller runs this after the completion subsystem has collected the final
/// result, so `result` is the payload the wrapped emitter forwards.
pub(crate) async fn emit_done_frames<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
) -> RedisResult<()> {
    let sanitized = match sanitize_client_payload(result) {
        Value::Object(object) if object.is_empty() => Value::Object(object),
        other => other,
    };
    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(event.task_id));
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    payload.insert("offset".into(), json!(event.offset));
    payload.insert("result".into(), sanitized);
    payload.insert(
        "message_id".into(),
        event.message_id.map_or(Value::Null, |value| json!(value)),
    );
    publish_emit(redis, "chat:done", event.task_id, Value::Object(payload)).await?;

    let status = match event.event_type.as_str() {
        "error" => "FAILED",
        "cancelled" => "CANCELLED",
        _ => "COMPLETED",
    };
    // `_emit_task_status` returns early when the task has no owner.
    let Some(user_id) = user_id else {
        return Ok(());
    };
    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(event.task_id));
    payload.insert("status".into(), Value::String(status.to_string()));
    payload.insert("progress".into(), Value::Null);
    payload.insert(
        "completed_at".into(),
        Value::String(
            chrono::Local::now()
                .naive_local()
                .format("%Y-%m-%dT%H:%M:%S%.6f")
                .to_string(),
        ),
    );
    publish_emit_in_room(
        redis,
        "task:status",
        &format!("user:{user_id}"),
        Value::Object(payload),
    )
    .await
    .map(|_| ())
}

/// `app/utils/client_payload_sanitizer.py sanitize_client_payload`: drop the
/// private workflow URL keys anywhere in the payload, preserving every other
/// key and its order.
fn sanitize_client_payload(payload: &Value) -> Value {
    const PRIVATE_KEYS: [&str; 3] = ["polling_url", "query_url", "task_url"];
    match payload {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| !PRIVATE_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), sanitize_client_payload(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sanitize_client_payload).collect()),
        other => other.clone(),
    }
}

/// `emit_chat_chunk` payload: fixed keyword order with optional fields.
fn chunk_payload(
    event: &ExecutionEvent,
    content: String,
    offset: i64,
    message_id: Option<i64>,
    block_id: Option<&str>,
    block_offset: Option<Value>,
    result: Option<Value>,
) -> Value {
    let mut payload = Map::new();
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    payload.insert("content".into(), Value::String(content));
    payload.insert("offset".into(), json!(offset));
    payload.insert("task_id".into(), json!(event.task_id));
    if let Some(message_id) = message_id {
        payload.insert("message_id".into(), json!(message_id));
    }
    if let Some(block_id) = block_id {
        payload.insert("block_id".into(), Value::String(block_id.to_string()));
    }
    if let Some(block_offset) = block_offset.filter(|value| !value.is_null()) {
        payload.insert("block_offset".into(), block_offset);
    }
    if let Some(result) = result {
        payload.insert("result".into(), result);
    }
    Value::Object(payload)
}

/// `emit_block_updated` payload: fixed keyword order with optional fields.
///
/// The source builds the payload from the passed keyword arguments in this
/// order; a value that is `None` (JSON null) or absent is omitted.
fn block_update_payload(
    event: &ExecutionEvent,
    block_id: &str,
    updates: &Map<String, Value>,
) -> Value {
    const KEYS: [&str; 9] = [
        "content",
        "tool_output",
        "tool_input",
        "parent_tool_use_id",
        "render_payload",
        "output",
        "summary",
        "children",
        "status",
    ];
    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(event.task_id));
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    payload.insert("block_id".into(), Value::String(block_id.to_string()));
    for key in KEYS {
        if let Some(value) = updates.get(key).filter(|value| !value.is_null()) {
            payload.insert(key.into(), value.clone());
        }
    }
    Value::Object(payload)
}

#[cfg(test)]
pub(crate) fn chunk_payload_for_test(
    event: &ExecutionEvent,
    content: &str,
    offset: i64,
    message_id: Option<i64>,
    block_id: Option<&str>,
    block_offset: Option<Value>,
    result: Option<Value>,
) -> Value {
    chunk_payload(
        event,
        content.to_string(),
        offset,
        message_id,
        block_id,
        block_offset,
        result,
    )
}

#[cfg(test)]
#[path = "emitter_tests.rs"]
mod done_frame_tests;
