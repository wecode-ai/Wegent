// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Chat-shell SSE collection for the create flow's synchronous branch.
//!
//! Mirrors `execution/chat_shell_sse.py::dispatch_sse` with an
//! `SSEResultEmitter` wrapped in `StatusUpdatingEmitter`, plus
//! `dispatcher.py::dispatch` and `QueueBasedEmitter.collect`:
//!
//! * consumes the chat-shell `POST {url}/v1/responses` event stream;
//! * persists every parsed event through the same streaming emitter the
//!   callback endpoint uses (without the Socket.IO forwarding the wrapped
//!   `WebSocketResultEmitter` performs);
//! * runs the terminal-completion subsystem when the stream reports
//!   `response.completed` / `error` / `response.incomplete`;
//! * accumulates `chunk` content for the create response's
//!   `active_assistant_content`.
//!
//! Cancellation polling (`session_manager.register_stream` / `is_cancelled` /
//! `unregister_stream`) is reproduced so a cross-worker cancel stops the read
//! at the source's GET -> one-second -> GET cadence. `_wait_for_sse_cancellation`
//! is an independent task created before the stream opens and cancelled only in
//! `finally`, so one pinned poll future spans the open wait, the event consume
//! loop, and the terminal drain.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_mysql::Mysql;
use brz_redis::Redis;
use serde_json::Value;

use crate::executor_manager::ExecutorManager;
use crate::internal_callback::completion;
use crate::internal_callback::completion::Tables;
use crate::internal_callback::emitter::StatusUpdatingEmitter;
use crate::internal_callback::event::{EventType, ExecutionEvent};
use crate::internal_callback::is_cancelled;
use crate::internal_callback::parser;
use crate::state::AppState;

use super::dispatch::{self, ExecutionRequest};

/// The dependencies one chat-shell SSE consumer needs.
///
/// The synchronous create branch builds this from `AppState`; the background
/// dispatch worker owns its handles in
/// [`crate::responses::dispatch::ConsumerState`] and upgrades the request-time
/// `Weak<AppState>` for the completion notification path. Keeping the inputs
/// explicit lets a focused test drive the real consumer through the worker with
/// recording MySQL/Redis doubles.
pub(crate) struct ConsumerContext<'a, M: Mysql, R: Redis> {
    pub mysql: &'a M,
    pub redis: Option<&'a R>,
    pub tables: Tables,
    pub executor_manager: &'a ExecutorManager,
    /// `Completion.app`: the subscription notification handler reads it.
    pub app: Option<&'a AppState>,
}

impl<'a> ConsumerContext<'a, brz_mysql::MysqlService, brz_redis::RedisService> {
    /// The production context for one request whose dispatch runs inside the
    /// request (the synchronous create branch and the background job paths).
    pub(crate) fn from_app(state: &'a AppState) -> Self {
        Self {
            mysql: &state.mysql,
            redis: state.redis.as_ref(),
            tables: crate::internal_callback::tables(state),
            executor_manager: &state.executor_manager,
            app: Some(state),
        }
    }
}

/// `session_manager._get_cancel_key` (`app/services/chat/storage/session.py`).
const CANCEL_KEY_PREFIX: &str = "chat:cancel:";
/// `_SSE_CANCEL_POLL_INTERVAL_SECONDS`.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// The chat-shell per-read timeout (`httpx`'s 300-second default).
///
/// This is an inactivity window, not a total request deadline. A streaming
/// response may legitimately run longer than this as long as chunks keep
/// arriving.
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// `_SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS`: the bounded tail read after a
/// delivered terminal event.
const TERMINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
/// The OpenAI SDK appends `/responses` to its `.../v1` base URL.
const RESPONSES_PATH: &str = "/v1/responses";

/// Events that end the read (`ResponsesAPIStreamEvents` terminal values).
const TERMINAL_EVENT_TYPES: [&str; 3] = ["response.completed", "error", "response.incomplete"];

/// The collected result of a synchronous chat-shell dispatch.
#[derive(Debug)]
pub(crate) struct Collected {
    /// `QueueBasedEmitter.collect`'s accumulated `chunk` content.
    pub content: String,
}

/// One failed dispatch the caller renders as
/// `500 {"detail": "LLM request failed: <message>"}`.
struct Failure {
    message: String,
    /// The terminal status was already persisted by the failure branch.
    persist: bool,
    error_code: Option<&'static str>,
}

impl Failure {
    /// A failure the dispatcher's `except` branch persists as FAILED.
    fn persisted(message: String) -> Self {
        Self {
            message,
            persist: true,
            error_code: None,
        }
    }
}

/// Consume one chat-shell event stream for the synchronous create branch.
///
/// The returned error message is the source's `str(exception)` rendered into
/// `500 {"detail": "LLM request failed: <message>"}` by the caller.
pub(crate) async fn collect<M: Mysql, R: Redis + Clone>(
    ctx: &ConsumerContext<'_, M, R>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
) -> Result<Collected, String> {
    collect_with_read_timeout(
        ctx,
        target_url,
        request,
        request_id,
        message_id,
        STREAM_TIMEOUT,
    )
    .await
}

async fn collect_with_read_timeout<M: Mysql, R: Redis + Clone>(
    ctx: &ConsumerContext<'_, M, R>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    read_timeout: Duration,
) -> Result<Collected, String> {
    let Some(redis) = ctx.redis else {
        return Err("Connection error.".to_string());
    };

    let mut emitter =
        StatusUpdatingEmitter::new(redis.clone(), request.task_id, request.subtask_id);
    let cancel_key = format!("{CANCEL_KEY_PREFIX}{}", request.subtask_id);
    // `register_stream`: clear a stale cross-worker cancellation flag.
    let _ = redis.del(cancel_key.as_str()).await;

    let result = read_stream(
        ctx,
        target_url,
        request,
        request_id,
        message_id,
        redis,
        &mut emitter,
        cancel_key.as_str(),
        read_timeout,
    )
    .await;

    // `dispatch`'s finally: `wrapped_emitter.close()` flushes buffered content.
    emitter.close().await;
    // `_dispatch_chat_shell_sse`'s finally: `unregister_stream`.
    let _ = redis.del(cancel_key.as_str()).await;

    match result {
        Ok(collected) => Ok(collected),
        Err(failure) => {
            if failure.persist {
                complete_failure(ctx, request, &failure).await;
            }
            Err(failure.message)
        }
    }
}

/// `_wait_for_sse_cancellation`'s Redis half, driven as one future for the
/// whole dispatch.
///
/// The Source's `poll_redis` issues a GET, sleeps one full interval, then
/// issues the next GET (`chat_shell_sse.py:97-101`), so a slow read delays the
/// following poll instead of firing on a fixed grid. The loop is created before
/// the stream opens (`:235`) and cancelled in `finally` (`:533-548`); the call
/// site waits for the cancelled poller before `unregister_stream`.
///
/// `stop` halts scheduling of new reads, but it never interrupts an admitted
/// `is_cancelled` GET: dropping an already-admitted command does not recall it
/// (`brz-redis` admits the envelope before returning the response future), so
/// its bytes could reach Redis after the unregister `DEL`. The loop therefore
/// awaits every GET to completion and only races `stop` against the interval
/// sleep.
async fn poll_cancellation<R: Redis>(
    redis: &R,
    key: &str,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    loop {
        if is_cancelled(redis, key).await {
            return;
        }
        tokio::select! {
            biased;
            _ = &mut stop => return,
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {}
        }
    }
}

/// Poll `future` once, returning its output when it is immediately ready.
///
/// Used to issue the poll loop's initial GET before the stream opens without
/// waiting for the read or for the next interval.
async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Option<F::Output> {
    tokio::select! {
        biased;
        output = &mut future => Some(output),
        _ = std::future::ready(()) => None,
    }
}

/// How the consume phase ended when the stream branch won the cancel race.
enum StreamEnd {
    /// A terminal event was delivered; `_drain_terminal_stream` still owns the
    /// framing tail.
    Terminal(brz_http::Response),
    /// The `error` terminal event's FAILED state was already persisted; drain,
    /// then report the failure.
    ErrorTerminal(brz_http::Response, Failure),
}

#[allow(clippy::too_many_arguments)]
async fn read_stream<M: Mysql, R: Redis>(
    ctx: &ConsumerContext<'_, M, R>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    redis: &R,
    emitter: &mut StatusUpdatingEmitter<R>,
    cancel_key: &str,
    read_timeout: Duration,
) -> Result<Collected, Failure> {
    let mut content = String::new();
    // `_wait_for_sse_cancellation` is created before `stream_open_task`
    // (`chat_shell_sse.py:235`) and cancelled in `finally` (`:533-548`), so this
    // one pinned future spans the open wait, the consume loop, and the drain.
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    let cancel = poll_cancellation(redis, cancel_key, stop_rx);
    tokio::pin!(cancel);

    // The poll loop's first `is_cancelled` GET runs before the stream opens, so
    // drive that one step now: an already-set flag resolves without waiting an
    // interval, while the same pinned future keeps running afterwards.
    let already_cancelled = poll_once(cancel.as_mut()).await.is_some();
    // A completed `async fn` future must never be polled again. Track the
    // poller's completion wherever it resolves (initial poll, the main race, or
    // the terminal drain) and join only a still-pending poll.
    let mut cancel_done = already_cancelled;

    // Scoped so the stream future releases its borrows of `emitter` and
    // `content` before the remaining phases use them.
    let end = {
        let open = open_and_consume(
            ctx,
            target_url,
            request,
            request_id,
            message_id,
            emitter,
            &mut content,
            read_timeout,
        );
        tokio::pin!(open);
        if already_cancelled {
            // The Source still creates `stream_open_task` before waiting on the
            // race and then drops it through `_cancel_sse_stream_open`; start
            // the request so an in-flight open is not skipped.
            let _ = poll_once(open.as_mut()).await;
            None
        } else {
            // `asyncio.wait({stream_task, cancel_task})`: the Source prefers the
            // stream branch when both complete in the same instant, and the
            // cancellation future keeps running across both phases.
            tokio::select! {
                biased;
                end = &mut open => Some(end),
                () = &mut cancel => {
                    cancel_done = true;
                    None
                }
            }
        }
    };
    let result = match end {
        None => finish_cancelled(ctx, request, emitter, &content).await,
        Some(Ok(StreamEnd::Terminal(mut response))) => {
            cancel_done |= drain_with_cancel_poll(&mut response, cancel.as_mut()).await;
            Ok(Collected { content })
        }
        Some(Ok(StreamEnd::ErrorTerminal(mut response, failure))) => {
            cancel_done |= drain_with_cancel_poll(&mut response, cancel.as_mut()).await;
            Err(failure)
        }
        Some(Err(failure)) => Err(failure),
    };
    // `finally` (`chat_shell_sse.py:533-548`): stop scheduling cancellation
    // reads, then await the one already-admitted GET before the caller runs
    // `unregister_stream`'s `DEL`. The join is a shutdown join, not a timer, and
    // it runs only for a still-pending poller: a late poll result is discarded
    // and can never reclassify the terminal outcome already decided above.
    let _ = stop.send(());
    if !cancel_done {
        let _ = cancel.as_mut().await;
    }
    result
}

/// Open the chat-shell stream and consume events until a terminal event, EOF,
/// or a transport failure.
///
/// Everything after `send()` - including the terminal event's persistence -
/// stays inside this future so the outer cancel race can interrupt it, exactly
/// like the Source's `stream_task.cancel()`.
#[allow(clippy::too_many_arguments)]
async fn open_and_consume<M: Mysql, R: Redis>(
    ctx: &ConsumerContext<'_, M, R>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    emitter: &mut StatusUpdatingEmitter<R>,
    content: &mut String,
    read_timeout: Duration,
) -> Result<StreamEnd, Failure> {
    let url = format!("{}{RESPONSES_PATH}", target_url.trim_end_matches('/'));
    // The source's OpenAI/httpx client uses a 300-second per-read timeout
    // (`x-stainless-read-timeout: 300.0` in the recorded request). The
    // `brz-http` default is 400 ms per socket read, which aborts an SSE stream
    // at its first recorded inter-chunk gap (up to ~1.2 s in the recording).
    let client = HttpClient::builder()
        .read_timeout(read_timeout)
        .build()
        .map_err(|_| Failure::persisted("Connection error.".to_string()))?;
    let payload = dispatch::assemble(request, true, false);
    let body = serde_json::to_value(&payload).unwrap_or(Value::Null);
    let http_request = client
        .post(&url)
        .map_err(|_| Failure::persisted("Connection error.".to_string()))?
        .header("content-type", "application/json")
        .header("accept", dispatch::OPENAI_ACCEPT)
        .header("authorization", dispatch::OPENAI_DUMMY_AUTHORIZATION)
        .header("X-Request-ID", request_id);
    // The Source client identity (`AsyncOpenAI`) on the streaming path; the
    // executor-manager dispatch applies the same shared set.
    let mut response = dispatch::apply_openai_client_headers(http_request)
        .json(&body)
        .send()
        .await
        .map_err(|_| Failure::persisted("Connection error.".to_string()))?;

    if !response.status().is_success() {
        return Err(Failure::persisted(format!(
            "HTTP status code: {}",
            response.status().as_u16()
        )));
    }

    let mut frames = SseFrames::default();
    let mut event_count = 0_u64;

    loop {
        // `_flush_stream_storage_after_delay` wakes exactly one second after
        // the first buffered piece; the cancel-poll tick has its own phase and
        // would otherwise decide different batch boundaries.
        let flush_at = emitter.flush_deadline();
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk,
            _ = async {
                match flush_at {
                    Some(at) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                // `_flush_stream_storage_after_delay` is a detached task that
                // only writes the buffered batch; the cancellation poller owns
                // the periodic `GET chat:cancel:*` reads.
                emitter.flush_due().await;
                continue;
            }
        };
        let chunk = chunk
            .map_err(|error| Failure::persisted(stream_transport_error(&error, read_timeout)))?;
        let Some(chunk) = chunk else { break };
        for event in frames.push(&chunk) {
            event_count += 1;
            let Some(event_type) = event.get("type").and_then(Value::as_str) else {
                continue;
            };
            let parsed = parser::shared()
                .parse(
                    request.task_id,
                    request.subtask_id,
                    message_id,
                    event_type,
                    &event,
                )
                .map_err(|error| Failure::persisted(error.0))?;
            if let Some(mut parsed) = parsed {
                if parsed.event_type == "chunk" {
                    content.push_str(&parsed.content);
                }
                if completion::terminal_status(&parsed.event_type).is_some() {
                    // `StatusUpdatingEmitter`'s terminal branch flushes the
                    // buffered stream content before completing the task.
                    emitter.close().await;
                    complete(ctx, &parsed).await;
                    if parsed.event_type == "error" {
                        // The FAILED state is already persisted; the caller
                        // drains the framing tail before reporting it.
                        return Ok(StreamEnd::ErrorTerminal(
                            response,
                            Failure {
                                message: parsed
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "Unknown error".to_string()),
                                persist: false,
                                error_code: None,
                            },
                        ));
                    }
                } else if let Err(error) = emitter.emit_persist_only(&mut parsed).await {
                    tracing::warn!(%error, "chat-shell stream persistence failed");
                }
            }
            if TERMINAL_EVENT_TYPES.contains(&event_type) {
                // `_drain_terminal_stream`: the source keeps reading to EOF (up
                // to one second) after a terminal event so the HTTP framing
                // completes; the delivered terminal state is unchanged.
                return Ok(StreamEnd::Terminal(response));
            }
        }
    }

    Err(Failure {
        message: format!(
            "Chat Shell SSE stream ended without terminal event after {event_count} events"
        ),
        persist: true,
        error_code: Some("sse_stream_no_terminal"),
    })
}

/// `_drain_terminal_stream`: finish the HTTP response framing after a
/// delivered terminal event by reading the remaining body for up to one
/// second. Read errors are ignored because the terminal state is already
/// persisted and delivered.
pub(super) async fn drain_terminal_stream(response: &mut brz_http::Response) {
    let drain = async { while let Ok(Some(_)) = response.chunk().await {} };
    let _ = tokio::time::timeout(TERMINAL_DRAIN_TIMEOUT, drain).await;
}

/// Render a stream transport failure without hiding an inactivity timeout
/// behind reqwest's generic body-decode message.
pub(super) fn stream_transport_error(error: &brz_http::Error, read_timeout: Duration) -> String {
    if error.is_timeout() {
        format!(
            "Chat Shell SSE stream read timed out after {}s without data",
            read_timeout.as_secs()
        )
    } else {
        error.to_string()
    }
}

/// `_drain_terminal_stream` driven alongside the still-live cancel poll.
///
/// The Source cancels `_wait_for_sse_cancellation` only in `finally`, so the
/// poll keeps issuing GETs through the drain. The stream branch has already
/// won, so a poll that completes here has no business effect: its result is
/// ignored and the drain stays non-cancellable.
async fn drain_with_cancel_poll<F: Future<Output = ()>>(
    response: &mut brz_http::Response,
    mut cancel: Pin<&mut F>,
) -> bool {
    let drain = drain_terminal_stream(response);
    tokio::pin!(drain);
    tokio::select! {
        () = &mut drain => return false,
        () = &mut cancel => {}
    }
    // The delivered terminal state already won; finish the bounded drain that
    // was under way without emitting another terminal event.
    drain.await;
    true
}

/// `StatusUpdatingEmitter`'s terminal branch: collect, persist, publish.
async fn complete<M: Mysql, R: Redis>(ctx: &ConsumerContext<'_, M, R>, event: &ExecutionEvent) {
    let Some(redis) = ctx.redis else {
        return;
    };
    let Some(status) = completion::terminal_status(&event.event_type) else {
        return;
    };
    let completion = completion::Completion {
        app: ctx.app,
        mysql: ctx.mysql,
        redis,
        tables: ctx.tables,
        executor_manager: ctx.executor_manager,
    };
    // `StatusUpdatingEmitter`'s terminal branch. The create flow wraps an
    // `SSEResultEmitter`, so the callback's `task:status` owner pre-read does
    // not run here.
    completion::complete_terminal_event(
        &completion,
        event.task_id,
        event.subtask_id,
        status,
        event.result.as_ref(),
        event.error.as_deref(),
        event.error_code.as_deref(),
        None,
        None,
    )
    .await;
}

/// The dispatcher's `except` branch: `emit_error` persists FAILED.
async fn complete_failure<M: Mysql, R: Redis>(
    ctx: &ConsumerContext<'_, M, R>,
    request: &ExecutionRequest,
    failure: &Failure,
) {
    let Some(redis) = ctx.redis else {
        return;
    };
    let completion = completion::Completion {
        app: ctx.app,
        mysql: ctx.mysql,
        redis,
        tables: ctx.tables,
        executor_manager: ctx.executor_manager,
    };
    completion::complete_terminal_event(
        &completion,
        request.task_id,
        request.subtask_id,
        "FAILED",
        None,
        Some(&failure.message),
        failure.error_code,
        None,
        None,
    )
    .await;
}

/// `dispatch_sse` emits a cancelled terminal event and stops reading;
/// `collect` keeps the accumulated content.
async fn finish_cancelled<M: Mysql, R: Redis>(
    ctx: &ConsumerContext<'_, M, R>,
    request: &ExecutionRequest,
    emitter: &mut StatusUpdatingEmitter<R>,
    content: &str,
) -> Result<Collected, Failure> {
    let event = ExecutionEvent::new(EventType::Cancelled, request.task_id, request.subtask_id);
    emitter.close().await;
    complete(ctx, &event).await;
    Ok(Collected {
        content: content.to_string(),
    })
}

/// Incremental `data:` frame reader for the chat-shell event stream.
#[derive(Default)]
pub(super) struct SseFrames {
    buffer: Vec<u8>,
}

impl SseFrames {
    /// Append a transport chunk and return every complete event JSON value.
    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((end, delimiter)) = next_frame(&self.buffer) {
            let frame: Vec<u8> = self.buffer.drain(..end + delimiter).collect();
            if let Some(event) = parse_frame(&frame[..end]) {
                events.push(event);
            }
        }
        events
    }
}

/// Locate the end of the next frame and its delimiter length.
fn next_frame(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < buffer.len() {
        if buffer[index] == b'\n' {
            if buffer.get(index + 1) == Some(&b'\n') {
                return Some((index, 2));
            }
            if buffer.get(index + 1) == Some(&b'\r') && buffer.get(index + 2) == Some(&b'\n') {
                return Some((index, 3));
            }
        }
        index += 1;
    }
    None
}

/// Join one frame's `data:` lines and decode them.
fn parse_frame(frame: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut data = String::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
    }
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frames_on_both_delimiters() {
        let mut frames = SseFrames::default();
        let events = frames.push(
            b"event: response.created\ndata: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"x\"}\r\n\r\n",
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "response.created");
        assert_eq!(events[1]["type"], "x");
    }

    #[test]
    fn joins_multiline_data_and_ignores_done() {
        assert_eq!(
            parse_frame(b"data: {\"type\":\ndata: \"response.completed\"}"),
            Some(serde_json::json!({"type": "response.completed"}))
        );
        assert_eq!(parse_frame(b"data: [DONE]"), None);
        assert_eq!(parse_frame(b"event: ping"), None);
    }

    #[test]
    fn keeps_partial_frames_buffered() {
        let mut frames = SseFrames::default();
        assert!(frames.push(b"data: {\"type\":\"a\"}").is_empty());
        assert_eq!(frames.push(b"\n\ndata: {\"type\":\"b\"}\n\n").len(), 2);
    }
}

#[cfg(test)]
#[path = "sse_sync_tests.rs"]
mod consumer_tests;
