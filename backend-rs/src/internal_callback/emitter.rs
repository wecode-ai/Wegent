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

use super::block_frames;
use super::event::ExecutionEvent;
use super::py_json::utc_isoformat;
use super::session;
use super::socketio::{
    publish_chat_start, publish_emit, publish_emit_in_room, publish_task_created,
};

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

struct BufferedStreamContent {
    content_type: StreamContentType,
    content: String,
    block_id: Option<String>,
    block_offset: Option<u64>,
}

/// `WebSocketResultEmitter`'s constructor data for the START branch's
/// `task:created` frame (`websocket.py:210-260` -> `webpage_ws_chat_emitter.py`
/// `emit_task_created`). Every field is required: the source emits only when
/// all of them are set.
#[derive(Debug, Clone)]
pub(crate) struct CreatedTask {
    pub user_id: i64,
    pub team_id: i64,
    pub team_name: String,
    pub title: String,
    pub is_group_chat: bool,
    pub project_id: i64,
}

/// The wrapper that persists stream state before forwarding to Socket.IO.
///
/// The emitter owns its Redis handle so a response-body stream can retain it
/// across polls; `RedisService` clones share one pool.
pub(crate) struct StatusUpdatingEmitter<R: Redis> {
    redis: R,
    task_id: i64,
    subtask_id: i64,
    observed_started_at: String,
    buffer: Vec<BufferedStreamContent>,
    first_buffered_at: Option<Instant>,
    last_activity_touch: Option<Instant>,
    created_task: Option<CreatedTask>,
}

impl<R: Redis> StatusUpdatingEmitter<R> {
    pub(crate) fn new(redis: R, task_id: i64, subtask_id: i64) -> Self {
        Self {
            redis,
            task_id,
            subtask_id,
            observed_started_at: utc_isoformat(chrono::Utc::now()),
            buffer: Vec::new(),
            first_buffered_at: None,
            last_activity_touch: None,
            created_task: None,
        }
    }

    /// Attach the START branch's `task:created` identity.
    pub(crate) fn with_created_task(mut self, created: CreatedTask) -> Self {
        self.created_task = Some(created);
        self
    }

    /// Batch matching content types and provider IDs without crossing an explicit
    /// Unicode code-point offset gap or merging overlapping callback replays.
    fn buffer_content(
        &mut self,
        content_type: StreamContentType,
        content: &str,
        block_id: Option<&str>,
        block_offset: Option<u64>,
    ) {
        if content.is_empty() {
            return;
        }
        if self.first_buffered_at.is_none() {
            self.first_buffered_at = Some(Instant::now());
        }
        match self.buffer.last_mut() {
            Some(last)
                if last.content_type == content_type
                    && last.block_id.as_deref() == block_id
                    && block_offset.is_none_or(|offset| {
                        last.block_offset.and_then(|previous| {
                            previous.checked_add(last.content.chars().count() as u64)
                        }) == Some(offset)
                    }) =>
            {
                last.content.push_str(content);
            }
            _ => self.buffer.push(BufferedStreamContent {
                content_type,
                content: content.to_string(),
                block_id: block_id.map(str::to_string),
                block_offset,
            }),
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

    /// Persist buffered items in arrival order, retaining each identified text
    /// block's starting offset so Redis can discard only its replayed prefix.
    async fn flush_stream_storage(&mut self) {
        self.first_buffered_at = None;
        let pending = std::mem::take(&mut self.buffer);
        if pending.is_empty() {
            return;
        }
        for item in pending {
            let result = match item.content_type {
                StreamContentType::Text => match item.block_id.as_deref() {
                    Some(block_id) => {
                        session::add_identified_text_content(
                            &self.redis,
                            self.subtask_id,
                            &item.content,
                            block_id,
                            item.block_offset,
                        )
                        .await
                    }
                    None => {
                        session::add_text_content(&self.redis, self.subtask_id, &item.content).await
                    }
                },
                StreamContentType::Thinking => {
                    session::add_thinking_content(&self.redis, self.subtask_id, &item.content).await
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
        if let Err(error) = session::touch_task_streaming_activity(
            &self.redis,
            self.task_id,
            self.subtask_id,
            &self.observed_started_at,
        )
        .await
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

    /// The chat-shell dispatch's pre-HTTP START: the Source's
    /// `_dispatch_chat_shell_sse` awaits `emitter.emit_start` on the wrapped
    /// emitter before opening the request, and that wrapper only publishes the
    /// frames — it never runs `StatusUpdatingEmitter.emit`, so no
    /// `chat:task_streaming` marker exists before the POST. The marker is
    /// established later, by the parsed `response.created` START that reaches
    /// [`Self::emit`].
    pub(crate) async fn emit_start_forward_only(
        &mut self,
        message_id: Option<i64>,
        data: &Value,
    ) -> RedisResult<()> {
        let mut event = ExecutionEvent::new(
            super::event::EventType::Start,
            self.task_id,
            self.subtask_id,
        );
        event.message_id = message_id;
        event.data = data.as_object().cloned().unwrap_or_default();
        self.forward_to_socketio(&event).await
    }

    /// Buffer body deltas with their optional provider identity, then flush them
    /// before collecting a boundary event's completed block snapshot.
    async fn persist(&mut self, event: &mut ExecutionEvent) -> RedisResult<()> {
        match event.event_type.as_str() {
            "start" => {
                self.observed_started_at = utc_isoformat(chrono::Utc::now());
                session::set_task_streaming_status(
                    &self.redis,
                    self.task_id,
                    self.subtask_id,
                    0,
                    "",
                )
                .await?;
            }
            "chunk" => self.buffer_content(
                StreamContentType::Text,
                &event.content,
                event
                    .data
                    .get("block_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty()),
                event.data.get("block_offset").and_then(Value::as_u64),
            ),
            "thinking" => {
                self.buffer_content(StreamContentType::Thinking, &event.content, None, None);
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
                        event.data.get("render_payload"),
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
                publish_chat_start(
                    &self.redis,
                    event.task_id,
                    event.subtask_id,
                    bot_name,
                    shell_type,
                    event.message_id,
                )
                .await?;
                // `WebSocketResultEmitter.emit`'s START branch also emits
                // `task:created` for the owner's user room.
                if let Some(created) = &self.created_task {
                    publish_task_created(&self.redis, event.task_id, created).await?;
                }
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
                block_frames::publish_tool_block_created(&self.redis, event).await?;
            }
            "tool_argument_delta" | "tool_argument_done" => {
                let status = if event.event_type == "tool_argument_delta" {
                    "generating_arguments"
                } else {
                    "pending"
                };
                block_frames::publish_argument_updated(&self.redis, event, status).await?;
            }
            "tool_result" => {
                block_frames::publish_result_updated(&self.redis, event).await?;
            }
            "block_created" => {
                block_frames::publish_direct_block_created(&self.redis, event).await?;
            }
            "block_updated" => {
                block_frames::publish_direct_block_updated(&self.redis, event).await?;
            }
            "status_updated" => {
                super::status_frames::emit_status_updated(&self.redis, event).await?;
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
/// (`app/services/execution/emitters/websocket.py:157-191`): the event's own
/// frame, then the `task:status` frame for the owner's `user:{user_id}` room.
///
/// The caller runs this after the completion subsystem has collected the final
/// result, so `result` is the payload the wrapped emitter forwards for DONE.
pub(crate) async fn emit_terminal_frames<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
    contexts: Option<&Value>,
) -> RedisResult<()> {
    let (name, status, payload) = match event.event_type.as_str() {
        "error" => ("chat:error", "FAILED", error_payload(event)),
        "cancelled" => ("chat:cancelled", "CANCELLED", cancelled_payload(event)),
        _ => return emit_done_frames(redis, event, user_id, result, None, contexts).await,
    };
    publish_emit(redis, name, event.task_id, payload).await?;
    emit_task_status_frame(redis, event, user_id, status).await
}

pub(crate) async fn emit_terminal_frames_once<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
    contexts: Option<&Value>,
) -> RedisResult<()> {
    let room = format!("task:{}", event.task_id);
    let publish = async |name: &str, room: &str, step: &str, payload: Value| {
        let key = super::completion::notification_key(event.task_id, event.subtask_id, step);
        super::socketio::publish_terminal_emit(redis, &key, name, room, payload).await
    };
    let (name, status, payload) = match event.event_type.as_str() {
        "error" => ("chat:error", "FAILED", error_payload(event)),
        "cancelled" => ("chat:cancelled", "CANCELLED", cancelled_payload(event)),
        _ => {
            for (index, payload) in
                block_frames::guidance_created_payloads(event.task_id, event.subtask_id, result)
                    .into_iter()
                    .enumerate()
            {
                publish(
                    "chat:block_created",
                    &room,
                    &format!("guidance:{index}"),
                    payload,
                )
                .await?;
            }
            (
                "chat:done",
                "COMPLETED",
                done_payload(event, result, contexts),
            )
        }
    };
    publish(name, &room, "result", payload).await?;
    if let Some(user_id) = user_id {
        publish(
            "task:status",
            &format!("user:{user_id}"),
            "status",
            task_status_payload(event, status),
        )
        .await?;
    }
    Ok(())
}

/// `WebSocketResultEmitter.emit`'s DONE branch: the `chat:done` result frame
/// for `task:{task_id}`, then the `task:status` frame.
///
/// `contexts` is the completed assistant message's committed context briefs
/// (`websocket.py:_load_context_briefs` -> `get_briefs_by_subtask`), which the
/// Source always includes in the `chat:done` payload. Error/cancelled frames
/// carry no `contexts` field.
pub(crate) async fn emit_done_frames<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
    task_status: Option<&str>,
    contexts: Option<&Value>,
) -> RedisResult<()> {
    // `_emit_result_guidance_blocks` runs before `emit_chat_done`.
    block_frames::publish_guidance_blocks(redis, event, result).await?;
    publish_emit(
        redis,
        "chat:done",
        event.task_id,
        done_payload(event, result, contexts),
    )
    .await?;

    let status = task_status.unwrap_or(match event.event_type.as_str() {
        "error" => "FAILED",
        "cancelled" => "CANCELLED",
        _ => "COMPLETED",
    });
    emit_task_status_frame(redis, event, user_id, status).await
}

fn done_payload(event: &ExecutionEvent, result: &Value, contexts: Option<&Value>) -> Value {
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
    // `emit_chat_done` always includes the `contexts` key for DONE frames.
    payload.insert("contexts".into(), contexts.cloned().unwrap_or(Value::Null));
    Value::Object(payload)
}

/// `_emit_task_status`'s `task:status` frame; it returns early without a task
/// owner.
async fn emit_task_status_frame<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    status: &str,
) -> RedisResult<()> {
    let Some(user_id) = user_id else {
        return Ok(());
    };
    publish_emit_in_room(
        redis,
        "task:status",
        &format!("user:{user_id}"),
        task_status_payload(event, status),
    )
    .await
    .map(|_| ())
}

/// `emit_chat_error`'s payload (`webpage_websocket_chat_emitter.py:207-215`):
/// a fixed key order with the optional `type`/`message_id` omitted when unset.
fn error_payload(event: &ExecutionEvent) -> Value {
    let error = event
        .error
        .as_deref()
        .filter(|text| !text.is_empty())
        .unwrap_or("Unknown error");
    let mut payload = Map::new();
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    payload.insert("error".into(), Value::String(error.to_string()));
    payload.insert("task_id".into(), json!(event.task_id));
    if let Some(error_type) = event.error_code.as_deref() {
        payload.insert("type".into(), Value::String(error_type.to_string()));
    }
    if let Some(message_id) = event.message_id {
        payload.insert("message_id".into(), json!(message_id));
    }
    Value::Object(payload)
}

/// `emit_chat_cancelled`'s payload (`webpage_websocket_chat_emitter.py:240-244`).
fn cancelled_payload(event: &ExecutionEvent) -> Value {
    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(event.task_id));
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    Value::Object(payload)
}

/// `emit_task_status`'s payload (`webpage_websocket_chat_emitter.py:575-585`).
fn task_status_payload(event: &ExecutionEvent, status: &str) -> Value {
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
    Value::Object(payload)
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

#[cfg(test)]
#[path = "streaming_activity_redis_tests.rs"]
mod streaming_activity_redis_tests;
