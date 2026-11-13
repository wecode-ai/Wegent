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
use super::sse_sync::{SseFrames, drain_terminal_stream, stream_request, stream_transport_error};
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

/// Build the streaming SSE body for one chat-shell create request.
pub(super) fn stream(
    state: &AppState,
    request: &ExecutionRequest,
    input: &BridgeInput<'_>,
) -> Result<BodyStream, FastApiError> {
    body_stream(Bridge::new(state, request, input, Mode::ChatShell)?)
}

/// Build the streaming SSE body for one HTTP+Callback executor request
/// (`openapi_responses.py:1352-1379`): subscribe to the callback channel first,
/// then fire-and-forget the executor dispatch, then stream the pushed events.
pub(super) fn stream_callback(
    state: &AppState,
    request: &ExecutionRequest,
    input: &BridgeInput<'_>,
) -> Result<BodyStream, FastApiError> {
    body_stream(Bridge::new(
        state,
        request,
        input,
        Mode::Callback {
            dispatch_url: input.target_url.map(str::to_owned),
        },
    )?)
}

fn body_stream(bridge: Bridge) -> Result<BodyStream, FastApiError> {
    Ok(Box::pin(stream::unfold(bridge, |mut bridge| async move {
        bridge
            .next()
            .await
            .map(|bytes| (Ok::<_, io::Error>(bytes), bridge))
    })))
}

use super::callback_source::{
    CallbackEventSource, CallbackMessage, CallbackSourceError, callback_channel,
};
use events::{Chunk, ResponseState};
use tools::{ToolState, tool_result_chunk, tool_start_chunk, tool_update};

/// Which upstream feeds the bridge.
enum Mode {
    /// `SSE` target: the chat-shell HTTP stream.
    ChatShell,
    /// `HTTP_CALLBACK` target: the callback Pub/Sub channel, plus the
    /// fire-and-forget executor dispatch issued after subscribing.
    Callback { dispatch_url: Option<String> },
}

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
    mode: Mode,
    /// The chat-shell HTTP response (`Mode::ChatShell` after `open`).
    response: Option<brz_http::Response>,
    /// The callback-channel subscription (`Mode::Callback` after `open`).
    subscription: Option<Box<dyn CallbackEventSource>>,
    /// `Mode::Callback`: the executor-manager dispatch issued after the
    /// subscription exists (`openapi_responses.py:1365-1370`).
    callback_dispatch: Option<(String, ExecutionRequest)>,
    frames: SseFrames,
    poll: tokio::time::Interval,
    queue: VecDeque<Bytes>,
    state: ResponseState,
    /// `raw_chat_stream`'s per-tool lifecycle state, keyed by tool-use id and
    /// recorded on TOOL_START (`openapi_responses.py:1458-1474`).
    tool_states: HashMap<String, ToolState>,
    registered: bool,
    /// `_dispatch_chat_shell_sse`'s `finally: unregister_stream` already ran
    /// its single `DEL chat:cancel` for this stream.
    inner_unregistered: bool,
    terminal: bool,
    finished: bool,
    failed_terminal: bool,
}

impl Bridge {
    fn new(
        state: &AppState,
        request: &ExecutionRequest,
        input: &BridgeInput<'_>,
        mode: Mode,
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
        let chat_shell_url = match mode {
            Mode::ChatShell => Some(input.target_url.ok_or_else(|| {
                FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "LLM request failed: Chat Shell SSE dispatch requires a target URL",
                )
            })?),
            Mode::Callback { .. } => None,
        };
        let mut poll = tokio::time::interval(CANCEL_POLL_INTERVAL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let redis = state.redis.clone();
        let emitter = redis
            .clone()
            .map(|redis| StatusUpdatingEmitter::new(redis, request.task_id, request.subtask_id));
        let callback_dispatch = match &mode {
            Mode::Callback {
                dispatch_url: Some(url),
            } => Some((url.clone(), request.clone())),
            Mode::ChatShell | Mode::Callback { dispatch_url: None } => None,
        };
        Ok(Self {
            app: state.completion_app.get().cloned().unwrap_or_default(),
            http: HttpClient::builder()
                .read_timeout(STREAM_TIMEOUT)
                .build()
                .map_err(|_| FastApiError::internal())?,
            url: chat_shell_url
                .map(|url| format!("{}{RESPONSES_PATH}", url.trim_end_matches('/')))
                .unwrap_or_default(),
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
            mode,
            response: None,
            subscription: None,
            callback_dispatch,
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
            inner_unregistered: false,
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
            let opened = match &self.mode {
                Mode::ChatShell => self.response.is_some(),
                Mode::Callback { .. } => self.subscription.is_some(),
            };
            if !opened {
                if let Err(failure) = self.open().await {
                    self.fail(failure).await;
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
                Message(std::result::Result<Option<CallbackMessage>, CallbackSourceError>),
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
            let flush = async {
                match flush_at {
                    Some(at) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            let step = if let Some(subscription) = self.subscription.as_mut() {
                // `_iter_callback_events`: one `get_message(timeout=1.0)` poll,
                // no `?` on a timeout. The source checks the cancellation flag
                // only once per delivered event, so the callback source has no
                // periodic cancel read and no emitter flush deadline.
                tokio::select! {
                    message = subscription.next_message() => Step::Message(message),
                    _ = flush => Step::Flush,
                }
            } else {
                let response = self.response.as_mut().expect("opened");
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
                    self.fail_stream_end(
                        "Chat Shell SSE stream ended without terminal event".to_string(),
                    )
                    .await;
                }
                Step::Chunk(Err(error)) => {
                    self.fail(BridgeFailure::from_message(stream_transport_error(
                        &error,
                        STREAM_TIMEOUT,
                    )))
                    .await;
                }
                Step::Message(Ok(Some(message))) => {
                    self.consume_message(&message.payload).await;
                }
                // A read-timeout tick: `_iter_callback_events` keeps polling.
                Step::Message(Ok(None)) => {}
                Step::Message(Err(error)) => {
                    self.fail(BridgeFailure::generic(error.message)).await;
                }
            }
        }
    }

    async fn open(&mut self) -> Result<(), BridgeFailure> {
        match &self.mode {
            Mode::ChatShell => {
                // `raw_chat_stream` registers the stream before creating the
                // dispatch task, and `_dispatch_chat_shell_sse` registers it
                // again for its own reader; both clear the same cancellation
                // flag.
                if let Some(redis) = &self.redis {
                    let _ = redis.del(self.cancel_key.as_str()).await;
                    let _ = redis.del(self.cancel_key.as_str()).await;
                    // Two cancellation reads precede the START write.
                    // `raw_chat_stream` checks before handling the first event,
                    // and `_wait_for_sse_cancellation` starts its poll loop
                    // with another immediate `is_cancelled` read. Both reads
                    // consume the recorded `GET chat:cancel:{subtask}`
                    // commands, and the second one is the lane barrier ahead
                    // of the persisted `chat:task_streaming` SET.
                    let _ = is_cancelled(redis, self.cancel_key.as_str()).await;
                    let _ = is_cancelled(redis, self.cancel_key.as_str()).await;
                }
                // `tokio::time::interval` completes its first tick
                // immediately; the source's poller has already used that slot
                // for the reads above.
                self.poll.tick().await;
            }
            Mode::Callback { .. } => {
                // `session_manager.register_stream` (`session.py:267-291`):
                // one `DEL chat:cancel:{subtask}` clears a retry's flag. The
                // source creates only a local event here, so no Redis read
                // precedes the subscription.
                if let Some(redis) = &self.redis {
                    let _ = redis.del(self.cancel_key.as_str()).await;
                }
            }
        }
        self.registered = true;
        match &self.mode {
            Mode::ChatShell => self.open_chat_shell().await,
            Mode::Callback { .. } => self.open_callback().await,
        }
    }

    /// `SSE` target: open the chat-shell stream, which triggers the dispatch.
    async fn open_chat_shell(&mut self) -> Result<(), BridgeFailure> {
        let request = stream_request(&self.http, &self.url, &self.body, &self.request_id)
            .map_err(|_| BridgeFailure::network("Connection error.".to_string()))?;
        let response = self
            .http
            .execute(request)
            .await
            .map_err(|_| BridgeFailure::network("Connection error.".to_string()))?;
        if !response.status().is_success() {
            return Err(BridgeFailure::status(response.status().as_u16()));
        }
        self.response = Some(response);
        Ok(())
    }

    /// `HTTP_CALLBACK` target (`openapi_responses.py:1352-1370`): subscribe to
    /// the callback channel, then fire-and-forget the executor dispatch.
    async fn open_callback(&mut self) -> Result<(), BridgeFailure> {
        let Some(app) = self.app.upgrade() else {
            return Err(BridgeFailure::generic(
                "Application state unavailable".to_string(),
            ));
        };
        let Some(provider) = app.callback_subscriptions.as_ref() else {
            return Err(BridgeFailure::generic(
                "Failed to subscribe to callback stream channel".to_string(),
            ));
        };
        let channel = callback_channel(self.subtask_id);
        let subscription = provider.subscribe(&channel).await.map_err(|error| {
            BridgeFailure::generic(format!(
                "Failed to subscribe to callback stream channel: {}",
                error.message
            ))
        })?;
        self.subscription = Some(subscription);
        // Subscribe before submission so even a preparation failure can be streamed.
        if let Some((url, request)) = self.callback_dispatch.as_mut() {
            super::seam::dispatch_executor_after_subscribe(
                &app,
                request,
                Some(url),
                &self.request_id,
            )
            .await
            .map_err(|error| {
                BridgeFailure::generic(
                    error
                        .detail_message()
                        .unwrap_or("Executor recovery failed")
                        .to_owned(),
                )
            })?;
        }
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
            let Ok(Some(parsed)) = parsed else {
                if let Err(error) = parsed {
                    self.fail(BridgeFailure::generic(error.0)).await;
                    return;
                }
                continue;
            };
            if self.handle_parsed(parsed).await {
                return;
            }
        }
    }

    /// One callback-channel push (`_iter_callback_events`): the payload is the
    /// `ExecutionEvent` JSON `/internal/callback` publishes.
    async fn consume_message(&mut self, payload: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(payload) else {
            // `_iter_callback_events`'s `json.loads` raises: the stream fails
            // instead of silently skipping the event and its cancel read.
            self.fail(BridgeFailure::generic(
                "invalid callback event payload".to_string(),
            ))
            .await;
            return;
        };
        let parsed = ExecutionEvent::from_value(&value);
        self.handle_parsed(parsed).await;
    }

    /// `raw_chat_stream`'s per-event body (`openapi_responses.py:1391-1640`),
    /// shared by the chat-shell and callback event sources. Returns `true` when
    /// the event ended the stream.
    async fn handle_parsed(&mut self, mut parsed: ExecutionEvent) -> bool {
        if let Some(status) = completion::terminal_status(&parsed.event_type) {
            self.finish_terminal(&mut parsed, status).await;
            return true;
        }
        // The chat-shell stream persists each event through the session's
        // emitter. The callback consumer runs with `emitter=None`
        // (`openapi_responses.py:1360-1370`): `/internal/callback` already
        // persisted the event, so repeating it here would duplicate the
        // producer's writes.
        if !self.callback_mode()
            && let Some(emitter) = self.emitter.as_mut()
            && let Err(error) = emitter.emit_persist_only(&mut parsed).await
        {
            tracing::warn!(%error, "stream persistence failed");
        }
        // `raw_chat_stream` checks cancellation once per delivered event, after
        // the wrapper persisted and before it is transformed.
        if self.cancelled().await {
            self.cancel().await;
            return true;
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
                self.fail(BridgeFailure::generic(message)).await;
                return true;
            }
            _ => {}
        }
        for chunk in chunks {
            self.state.handle_chunk(&mut self.queue, chunk);
        }
        false
    }

    async fn finish_terminal(&mut self, event: &mut ExecutionEvent, status: &'static str) {
        if self.callback_mode() {
            // `/internal/callback` owns the terminal persistence; the consumer
            // only renders the event it received. The source still reads the
            // cancellation flag once for this event.
            if self.cancelled().await {
                self.cancel().await;
                return;
            }
        } else {
            if let Some(mut emitter) = self.emitter.take() {
                emitter.close().await;
            }
            let final_result = self
                .complete(status, event.result.as_ref(), event.error.as_deref(), None)
                .await;
            event.result = final_result;
            // `raw_chat_stream` checks cancellation after the wrapper persisted
            // and before it transforms the event.
            if self.cancelled().await {
                self.cancel().await;
                return;
            }
            // A delivered terminal event is persisted inside the emitter
            // before the dispatch exits, so this stream's one inner
            // `unregister_stream` runs after the completion.
            self.dispatch_exit_unregister().await;
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
        if self.callback_mode() {
            self.cleanup().await;
            self.state.finish(&mut self.queue, "completed", None);
            self.finished = true;
            return;
        }
        if let Some(mut emitter) = self.emitter.take() {
            emitter.close().await;
        }
        let _ = self.complete("CANCELLED", None, None, None).await;
        // Cancellation is observed after the dispatch exits; the inner
        // `unregister_stream` belongs to the dispatch, not the final response
        // cleanup.
        self.dispatch_exit_unregister().await;
        self.cleanup().await;
        self.state.finish(&mut self.queue, "completed", None);
        self.finished = true;
    }

    /// A transport failure (`open`/read/parse error): the upstream dispatch
    /// exits before the dispatcher's `except` branch persists the failure
    /// (`emit_error`), so the inner `unregister_stream` DEL precedes the
    /// FAILED completion.
    async fn fail(&mut self, failure: BridgeFailure) {
        self.fail_with_order(failure, FailureOrder::DispatchExitFirst)
            .await;
    }

    /// A stream that ended without a terminal event: the dispatcher emits its
    /// synthetic ERROR through the emitter, so the FAILED completion runs
    /// before the dispatch exits and its inner `unregister_stream` DEL.
    async fn fail_stream_end(&mut self, message: String) {
        self.fail_with_order(
            BridgeFailure::generic(message),
            FailureOrder::CompletionFirst,
        )
        .await;
    }

    /// `order` decides only where the dispatch-exit DEL lands; the failure
    /// carries its own `classify_error` code, which the FAILED completion
    /// persists as `result.error_type`.
    async fn fail_with_order(&mut self, failure: BridgeFailure, order: FailureOrder) {
        let BridgeFailure {
            message,
            error_code,
        } = failure;
        if self.callback_mode() {
            // The producer owns the failure persistence; the consumer renders
            // the failed stream and releases its subscription.
            self.cleanup().await;
            self.state.finish(
                &mut self.queue,
                "failed",
                Some(json!({"code": "stream_error", "message": message})),
            );
            self.finished = true;
            return;
        }
        if order == FailureOrder::DispatchExitFirst {
            self.dispatch_exit_unregister().await;
        }
        if let Some(mut emitter) = self.emitter.take() {
            emitter.close().await;
        }
        let failure_result = error_code.map(|code| json!({"error_type": code}));
        let _ = self
            .complete(
                "FAILED",
                failure_result.as_ref(),
                Some(&message),
                error_code,
            )
            .await;
        // `raw_chat_stream`'s per-event cancellation read for the failed event.
        let _ = self.cancelled().await;
        self.dispatch_exit_unregister().await;
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
        &mut self,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
        error_code: Option<&str>,
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
            error_code,
            None,
            None,
        )
        .await
    }

    /// The HTTP+Callback consumer never owns the session's persistence or
    /// completion; `/internal/callback` runs those producer-side effects.
    fn callback_mode(&self) -> bool {
        matches!(self.mode, Mode::Callback { .. })
    }

    async fn cancelled(&mut self) -> bool {
        match &self.redis {
            Some(redis) => is_cancelled(redis, &self.cancel_key).await,
            None => false,
        }
    }

    /// `_dispatch_chat_shell_sse`'s `finally: session_manager.unregister_stream`.
    ///
    /// The chat-shell dispatch task clears its cancellation flag once, when
    /// the upstream read ends. A transport failure exits the dispatch before
    /// the dispatcher persists the error, so this DEL precedes the FAILED
    /// completion; a delivered terminal event is persisted inside the emitter
    /// first, so there this DEL follows the completion. The final response
    /// cleanup (`raw_chat_stream`'s `finally`) runs its own DEL afterwards;
    /// both stages execute exactly once. `Mode::Callback` has no dispatch task
    /// in this process, so the producer owns its registration.
    async fn dispatch_exit_unregister(&mut self) {
        if self.inner_unregistered || self.callback_mode() || !self.registered {
            return;
        }
        self.inner_unregistered = true;
        if let Some(redis) = &self.redis {
            let _ = redis.del(self.cancel_key.as_str()).await;
        }
    }

    async fn cleanup(&mut self) {
        // `raw_chat_stream`'s `finally` closes the Pub/Sub client before it
        // unregisters the stream.
        if let Some(subscription) = self.subscription.take() {
            subscription.close().await;
        }
        if !self.registered {
            return;
        }
        if let Some(redis) = &self.redis {
            // `raw_chat_stream`'s `finally`: one `unregister_stream`
            // (`DEL chat:cancel:{subtask}`), then `delete_streaming_content`
            // (`DEL chat:streaming:{subtask}`). A chat-shell stream's dispatch
            // task ran its own unregister in `dispatch_exit_unregister`.
            let _ = redis.del(self.cancel_key.as_str()).await;
            let _ = redis
                .del(format!("chat:streaming:{}", self.subtask_id))
                .await;
        }
        self.registered = false;
    }
}

/// Where the dispatch-exit `unregister_stream` DEL sits relative to the
/// FAILED completion (`_dispatch_chat_shell_sse`'s `finally` versus the
/// dispatcher's `except` branch).
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailureOrder {
    /// A transport failure propagates out of the dispatch loop, so its
    /// `finally` runs before `ExecutionDispatcher.dispatch` persists the
    /// error through `emit_error`.
    DispatchExitFirst,
    /// The stream ended without a terminal event: the dispatcher emits a
    /// synthetic ERROR through the emitter (completion first), then exits.
    CompletionFirst,
}

/// One FAILED dispatch the dispatcher's `except` branch persists.
///
/// `error_code` is `classify_error`'s independent result
/// (`shared/utils/error_classifier.py`); it never follows from where the
/// dispatch exits. `collect_completed_result` writes a code into
/// `result.error_type` before the FAILED row is persisted.
struct BridgeFailure {
    message: String,
    error_code: Option<&'static str>,
}

impl BridgeFailure {
    /// `APIConnectionError` and `_classify_by_message`'s `network` rules:
    /// every connection-establishment failure renders `"Connection error."`.
    fn network(message: String) -> Self {
        Self {
            message,
            error_code: Some("network_error"),
        }
    }

    /// `classify_error`'s `generic_error` fallback for an exception the SDK
    /// class map does not know and whose message matches no keyword rule.
    fn generic(message: String) -> Self {
        Self {
            message,
            error_code: Some("generic_error"),
        }
    }

    /// The response read failed. The Source classifies the raised `httpx`
    /// exception by message (`_classify_by_message`), so apply the same
    /// network/timeout keyword rules before the generic fallback.
    fn from_message(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let network = [
            "network",
            "connection refused",
            "connection reset",
            "connection error",
            "not connected",
            "peer closed connection",
            "upstream connection interrupted",
        ];
        let timeout = ["timeout", "timed out"];
        let error_code = if timeout.iter().any(|pattern| lower.contains(pattern)) {
            "timeout_error"
        } else if network.iter().any(|pattern| lower.contains(pattern)) {
            "network_error"
        } else {
            "generic_error"
        };
        Self {
            message,
            error_code: Some(error_code),
        }
    }

    /// `open_chat_shell`'s non-2xx response. The Source SDK raises a typed
    /// `APIStatusError`; `classify_error` maps its class
    /// (`RateLimitError` -> `rate_limit`, `AuthenticationError` /
    /// `PermissionDeniedError` -> `forbidden`, `NotFoundError` /
    /// `InternalServerError` -> `model_unavailable`) and falls back to message
    /// classification for the rest.
    fn status(status: u16) -> Self {
        let error_code = match status {
            401 | 403 => "forbidden",
            404 => "model_unavailable",
            429 => "rate_limit",
            500..=599 => "model_unavailable",
            _ => "generic_error",
        };
        Self {
            message: format!("HTTP status code: {status}"),
            error_code: Some(error_code),
        }
    }
}

#[cfg(test)]
mod tests;
