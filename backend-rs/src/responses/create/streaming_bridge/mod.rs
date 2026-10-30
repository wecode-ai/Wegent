// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Streaming create bridge: chat-shell SSE → OpenAI Responses SSE.
//!
//! Mirrors `app/api/endpoints/openapi_responses.py:raw_chat_stream`
//! (`:1274-1740`) composed with
//! `app/services/openapi/streaming.py:OpenAPIStreamingService.
//! create_streaming_response`. The source returns a `StreamingResponse` whose
//! generator opens the chat-shell stream, transforms every internal
//! `ExecutionEvent` into `StreamingChunk`s, and the streaming service turns
//! those chunks into the OpenAI-compatible `data: {…}\n\n` frames the caller
//! receives.
//!
//! The response body is a lazy `Stream` (no per-request spawn): each poll
//! advances one upstream chunk, persists the parsed events through the same
//! [`StatusUpdatingEmitter`] the callback path uses, and queues the SSE frames
//! for that step.
mod events;
mod tools;

use std::collections::{HashMap, VecDeque};
use std::io;
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_http_server::Bytes;
use brz_mysql::MysqlService;
use brz_redis::{Redis as _, RedisService};
use futures_util::stream;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::internal_callback::completion::{self, Completion, Tables};
use crate::internal_callback::emitter::StatusUpdatingEmitter;
use crate::internal_callback::event::ExecutionEvent;
use crate::internal_callback::is_cancelled;
use crate::internal_callback::parser;
use crate::state::AppState;

use super::dispatch::{self, ExecutionRequest};
use super::seam::BodyStream;
use super::sse_sync::{SseFrames, drain_terminal_stream, stream_transport_error};
use super::streaming::framing_events;

/// `session_manager._get_cancel_key` (`chat:cancel:{subtask_id}`).
const CANCEL_KEY_PREFIX: &str = "chat:cancel:";
/// `_SSE_CANCEL_POLL_INTERVAL_SECONDS`.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// `httpx`'s 300-second streaming per-read timeout.
///
/// This is an inactivity window, not a total request deadline. A streaming
/// response may legitimately run longer than this as long as chunks keep
/// arriving.
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// The OpenAI SDK appends `/responses` to its `.../v1` base URL.
const RESPONSES_PATH: &str = "/v1/responses";

/// The inputs the streaming branch keeps from the resolved create flow.
pub(super) struct BridgeInput<'a> {
    pub model_string: &'a str,
    pub previous_response_id: Option<String>,
    pub request_id: &'a str,
    pub created_at: i64,
    pub target_url: Option<&'a str>,
}

/// Build the streaming SSE body for one create request.
pub(super) fn stream(
    state: &AppState,
    request: &ExecutionRequest,
    input: &BridgeInput<'_>,
) -> Result<BodyStream, FastApiError> {
    let bridge = Bridge::new(state, request, input)?;
    Ok(Box::pin(stream::unfold(bridge, |mut bridge| async move {
        bridge
            .next()
            .await
            .map(|bytes| (Ok::<_, io::Error>(bytes), bridge))
    })))
}

use events::{Chunk, ResponseState};
use tools::{ToolState, tool_result_chunk, tool_start_chunk, tool_update};

/// The streaming bridge's lazy body state.
struct Bridge {
    app: std::sync::Weak<AppState>,
    http: HttpClient,
    url: String,
    body: Value,
    request_id: String,
    task_id: i64,
    subtask_id: i64,
    message_id: Option<i64>,
    model_string: String,
    redis: Option<RedisService>,
    mysql: MysqlService,
    tables: Tables,
    executor_manager: crate::executor_manager::ExecutorManager,
    emitter: Option<StatusUpdatingEmitter<RedisService>>,
    cancel_key: String,
    response: Option<brz_http::Response>,
    frames: SseFrames,
    poll: tokio::time::Interval,
    queue: VecDeque<Bytes>,
    state: ResponseState,
    /// `raw_chat_stream`'s per-tool lifecycle state, keyed by tool-use id and
    /// recorded on TOOL_START (`openapi_responses.py:1458-1474`).
    tool_states: HashMap<String, ToolState>,
    registered: bool,
    terminal: bool,
    finished: bool,
    failed_terminal: bool,
}

impl Bridge {
    fn new(
        state: &AppState,
        request: &ExecutionRequest,
        input: &BridgeInput<'_>,
    ) -> Result<Self, FastApiError> {
        let mut queue = VecDeque::new();
        for event in framing_events(
            request.task_id,
            input.created_at,
            input.model_string,
            input.previous_response_id.clone(),
        ) {
            queue.push_back(event);
        }
        let Some(target_url) = input.target_url else {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                "LLM request failed: Chat Shell SSE dispatch requires a target URL",
            ));
        };
        let mut poll = tokio::time::interval(CANCEL_POLL_INTERVAL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let redis = state.redis.clone();
        let emitter = redis
            .clone()
            .map(|redis| StatusUpdatingEmitter::new(redis, request.task_id, request.subtask_id));
        Ok(Self {
            app: state.completion_app.get().cloned().unwrap_or_default(),
            http: HttpClient::builder()
                .read_timeout(STREAM_TIMEOUT)
                .build()
                .map_err(|_| FastApiError::internal())?,
            url: format!("{}{RESPONSES_PATH}", target_url.trim_end_matches('/')),
            body: serde_json::to_value(dispatch::assemble(request, true, false))
                .unwrap_or(Value::Null),
            request_id: input.request_id.to_string(),
            task_id: request.task_id,
            subtask_id: request.subtask_id,
            message_id: request.message_id,
            model_string: input.model_string.to_string(),
            redis,
            mysql: state.mysql.clone(),
            tables: crate::internal_callback::tables(state),
            executor_manager: state.executor_manager.clone(),
            emitter,
            cancel_key: format!("{CANCEL_KEY_PREFIX}{}", request.subtask_id),
            response: None,
            frames: SseFrames::default(),
            poll,
            queue,
            state: ResponseState::new(
                format!("resp_{}", request.task_id),
                input.model_string.to_string(),
                input.created_at,
                input.previous_response_id.clone(),
            ),
            tool_states: HashMap::new(),
            registered: false,
            terminal: false,
            finished: false,
            failed_terminal: false,
        })
    }

    async fn next(&mut self) -> Option<Bytes> {
        loop {
            if let Some(bytes) = self.queue.pop_front() {
                return Some(bytes);
            }
            if self.finished {
                return None;
            }
            if self.response.is_none() {
                if let Err(message) = self.open().await {
                    self.fail(message).await;
                    continue;
                }
                continue;
            }
            if self.terminal {
                self.drain_and_finish().await;
                continue;
            }

            enum Step {
                Chunk(std::result::Result<Option<Bytes>, brz_http::Error>),
                Tick,
                Flush,
            }
            // `_flush_stream_storage_after_delay` wakes exactly one second
            // after the first buffered piece. The cancel-poll tick has its own
            // phase, so it cannot drive the flush without changing the batch
            // boundaries persisted to Redis.
            let flush_at = self
                .emitter
                .as_ref()
                .and_then(StatusUpdatingEmitter::flush_deadline);
            let step = {
                let response = self.response.as_mut().expect("opened");
                let flush = async {
                    match flush_at {
                        Some(at) => {
                            tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
                        }
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    chunk = response.chunk() => Step::Chunk(chunk),
                    _ = self.poll.tick() => Step::Tick,
                    _ = flush => Step::Flush,
                }
            };
            match step {
                Step::Tick => {
                    if self.cancelled().await {
                        self.cancel().await;
                    }
                    continue;
                }
                Step::Flush => {
                    // `_flush_stream_storage_after_delay` is a detached task
                    // that only writes the buffered batch; the per-event read
                    // and the one-second poller own the cancellation reads.
                    if let Some(emitter) = self.emitter.as_mut() {
                        emitter.flush_due().await;
                    }
                    continue;
                }
                Step::Chunk(Ok(Some(chunk))) => {
                    self.consume(&chunk).await;
                }
                Step::Chunk(Ok(None)) => {
                    // Upstream EOF without a terminal event.
                    self.fail("Chat Shell SSE stream ended without terminal event".to_string())
                        .await;
                }
                Step::Chunk(Err(error)) => {
                    self.fail(stream_transport_error(&error, STREAM_TIMEOUT))
                        .await;
                }
            }
        }
    }

    async fn open(&mut self) -> Result<(), String> {
        // `raw_chat_stream` registers the stream before creating the dispatch
        // task, and `_dispatch_chat_shell_sse` registers it again for its own
        // reader; both clear the same cancellation flag.
        if let Some(redis) = &self.redis {
            let _ = redis.del(self.cancel_key.as_str()).await;
            let _ = redis.del(self.cancel_key.as_str()).await;
            // Two cancellation reads precede the START write. `raw_chat_stream`
            // checks before handling the first event, and
            // `_wait_for_sse_cancellation` starts its poll loop with another
            // immediate `is_cancelled` read. Both reads consume the recorded
            // `GET chat:cancel:{subtask}` commands, and the second one is the
            // lane barrier ahead of the persisted `chat:task_streaming` SET.
            let _ = is_cancelled(redis, self.cancel_key.as_str()).await;
            let _ = is_cancelled(redis, self.cancel_key.as_str()).await;
        }
        // `tokio::time::interval` completes its first tick immediately; the
        // source's poller has already used that slot for the reads above.
        self.poll.tick().await;
        self.registered = true;
        let request = self
            .http
            .post(&self.url)
            .map_err(|_| "Connection error.".to_string())?
            .header("content-type", "application/json")
            .header("accept", dispatch::OPENAI_ACCEPT)
            .header("authorization", dispatch::OPENAI_DUMMY_AUTHORIZATION)
            .header("X-Request-ID", self.request_id.as_str());
        // Same Source client identity as every other model-gateway call.
        let response = dispatch::apply_openai_client_headers(request)
            .json(&self.body)
            .send()
            .await
            .map_err(|_| "Connection error.".to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP status code: {}", response.status().as_u16()));
        }
        self.response = Some(response);
        Ok(())
    }

    async fn consume(&mut self, chunk: &[u8]) {
        let events = self.frames.push(chunk);
        for event in events {
            let Some(event_type) = event.get("type").and_then(Value::as_str) else {
                continue;
            };
            let parsed = parser::shared().parse(
                self.task_id,
                self.subtask_id,
                self.message_id,
                event_type,
                &event,
            );
            let Ok(Some(mut parsed)) = parsed else {
                if let Err(error) = parsed {
                    self.fail(error.0).await;
                    return;
                }
                continue;
            };
            if let Some(status) = completion::terminal_status(&parsed.event_type) {
                self.finish_terminal(&mut parsed, status).await;
                return;
            }
            if let Some(emitter) = self.emitter.as_mut()
                && let Err(error) = emitter.emit_persist_only(&mut parsed).await
            {
                tracing::warn!(%error, "chat-shell stream persistence failed");
            }
            // `raw_chat_stream` checks cancellation after the wrapper has
            // persisted the event and before it is transformed.
            if self.cancelled().await {
                self.cancel().await;
                return;
            }
            let mut chunks = Vec::new();
            match parsed.event_type.as_str() {
                "chunk" => {
                    self.state
                        .result_blocks(&mut self.queue, parsed.result.as_ref());
                    if !parsed.content.is_empty() {
                        chunks.push(Chunk::Text(parsed.content.clone()));
                    }
                }
                "thinking" => chunks.push(Chunk::Reasoning(parsed.content.clone())),
                "block_created" => {
                    if let Some(block) = parsed.data.get("block") {
                        chunks.push(Chunk::BlockCreated(block.clone()));
                    }
                }
                "block_updated" => {
                    if let (Some(block_id), Some(updates)) = (
                        parsed.data.get("block_id").and_then(Value::as_str),
                        parsed.data.get("updates"),
                    ) && updates.is_object()
                    {
                        chunks.push(Chunk::BlockUpdated {
                            block_id: block_id.to_string(),
                            updates: updates.clone(),
                        });
                    }
                }
                "tool_start" => {
                    if let Some(chunk) = tool_start_chunk(&mut self.tool_states, &parsed) {
                        chunks.push(chunk);
                    }
                }
                // `EventType.TOOL`: an `mcp_call` arguments update. It never
                // emits a client chunk and only touches a saved `mcp_call`.
                "tool" => tool_update(&mut self.tool_states, &parsed),
                "tool_result" => {
                    if let Some(chunk) = tool_result_chunk(&mut self.tool_states, &parsed) {
                        chunks.push(chunk);
                    }
                }
                "done" => self
                    .state
                    .result_blocks(&mut self.queue, parsed.result.as_ref()),
                "error" => {
                    let message = parsed
                        .error
                        .clone()
                        .unwrap_or_else(|| "Unknown error".to_string());
                    self.fail(message).await;
                    return;
                }
                _ => {}
            }
            for chunk in chunks {
                self.state.handle_chunk(&mut self.queue, chunk);
            }
        }
    }

    async fn finish_terminal(&mut self, event: &mut ExecutionEvent, status: &'static str) {
        if let Some(mut emitter) = self.emitter.take() {
            emitter.close().await;
        }
        let final_result = self
            .complete(status, event.result.as_ref(), event.error.as_deref())
            .await;
        event.result = final_result;
        // `raw_chat_stream` checks cancellation after the wrapper persisted and
        // before it transforms the event.
        if self.cancelled().await {
            self.cancel().await;
            return;
        }
        if status == "FAILED" {
            let message = event
                .error
                .clone()
                .unwrap_or_else(|| "Unknown error".to_string());
            self.state.finish(
                &mut self.queue,
                "failed",
                Some(json!({"code": "stream_error", "message": message})),
            );
            self.failed_terminal = true;
            self.terminal = true;
            return;
        }
        self.state
            .result_blocks(&mut self.queue, event.result.as_ref());
        self.terminal = true;
    }

    async fn drain_and_finish(&mut self) {
        if let Some(response) = self.response.as_mut() {
            drain_terminal_stream(response).await;
        }
        self.cleanup().await;
        if !self.finished && !self.failed_terminal {
            self.state.finish(&mut self.queue, "completed", None);
        }
        self.finished = true;
    }

    async fn cancel(&mut self) {
        if let Some(mut emitter) = self.emitter.take() {
            emitter.close().await;
        }
        let _ = self.complete("CANCELLED", None, None).await;
        self.cleanup().await;
        self.state.finish(&mut self.queue, "completed", None);
        self.finished = true;
    }

    async fn fail(&mut self, message: String) {
        if let Some(mut emitter) = self.emitter.take() {
            emitter.close().await;
        }
        let _ = self.complete("FAILED", None, Some(&message)).await;
        if let Some(response) = self.response.as_mut() {
            drain_terminal_stream(response).await;
        }
        self.cleanup().await;
        self.state.finish(
            &mut self.queue,
            "failed",
            Some(json!({"code": "stream_error", "message": message})),
        );
        self.finished = true;
    }

    async fn complete(
        &self,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Option<Value> {
        let (Some(redis), true) = (&self.redis, true) else {
            return None;
        };
        let app = self.app.upgrade();
        if app.is_none() {
            tracing::error!(
                task_id = self.task_id,
                "Application state unavailable during streamed task completion"
            );
        }
        let ctx = Completion {
            app: app.as_deref(),
            mysql: &self.mysql,
            redis,
            tables: self.tables,
            executor_manager: &self.executor_manager,
        };
        completion::complete_terminal_event(
            &ctx,
            self.task_id,
            self.subtask_id,
            status,
            result,
            error,
            None,
            None,
            None,
        )
        .await
    }

    async fn cancelled(&self) -> bool {
        match &self.redis {
            Some(redis) => is_cancelled(redis, &self.cancel_key).await,
            None => false,
        }
    }

    async fn cleanup(&mut self) {
        if !self.registered {
            return;
        }
        if let Some(redis) = &self.redis {
            // `_dispatch_chat_shell_sse` then `raw_chat_stream` each run
            // `unregister_stream`, then the latter deletes the streaming
            // content key.
            let _ = redis.del(self.cancel_key.as_str()).await;
            let _ = redis.del(self.cancel_key.as_str()).await;
            let _ = redis
                .del(format!("chat:streaming:{}", self.subtask_id))
                .await;
        }
        self.registered = false;
    }
}

#[cfg(test)]
mod tests {
    use super::events::message_id;

    #[test]
    fn message_ids_are_msg_plus_twelve_lower_hex() {
        let id = message_id();
        assert!(id.starts_with("msg_"));
        assert_eq!(id.len(), 16);
        assert!(
            id[4..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }
}
