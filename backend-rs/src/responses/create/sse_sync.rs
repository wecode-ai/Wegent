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
//! at the source's one-second cadence.

use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_redis::Redis as _;
use serde_json::Value;

use crate::internal_callback::completion;
use crate::internal_callback::emitter::StatusUpdatingEmitter;
use crate::internal_callback::event::{EventType, ExecutionEvent};
use crate::internal_callback::is_cancelled;
use crate::internal_callback::parser;
use crate::state::AppState;

use super::dispatch::{self, ExecutionRequest};

/// `session_manager._get_cancel_key` (`app/services/chat/storage/session.py`).
const CANCEL_KEY_PREFIX: &str = "chat:cancel:";
/// `_SSE_CANCEL_POLL_INTERVAL_SECONDS`.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// The chat-shell request timeout (`httpx`'s 300-second default).
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// `_SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS`: the bounded tail read after a
/// delivered terminal event.
const TERMINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
/// The OpenAI SDK appends `/responses` to its `.../v1` base URL.
const RESPONSES_PATH: &str = "/v1/responses";

/// Events that end the read (`ResponsesAPIStreamEvents` terminal values).
const TERMINAL_EVENT_TYPES: [&str; 3] = ["response.completed", "error", "response.incomplete"];

/// The collected result of a synchronous chat-shell dispatch.
pub(super) struct Collected {
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
pub(super) async fn collect(
    state: &AppState,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
) -> Result<Collected, String> {
    let Some(redis) = state.redis.as_ref() else {
        return Err("Connection error.".to_string());
    };

    let mut emitter =
        StatusUpdatingEmitter::new(redis.to_owned(), request.task_id, request.subtask_id);
    let cancel_key = format!("{CANCEL_KEY_PREFIX}{}", request.subtask_id);
    // `register_stream`: clear a stale cross-worker cancellation flag.
    let _ = redis.del(cancel_key.as_str()).await;
    // `_wait_for_sse_cancellation` starts its poll loop with an immediate
    // `is_cancelled` read, before the SSE dispatch emits the START event.
    let _ = is_cancelled(redis, cancel_key.as_str()).await;

    let result = read_stream(
        state,
        target_url,
        request,
        request_id,
        message_id,
        redis,
        &mut emitter,
        cancel_key.as_str(),
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
                complete_failure(state, request, &failure).await;
            }
            Err(failure.message)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn read_stream<R: brz_redis::Redis>(
    state: &AppState,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    redis: &R,
    emitter: &mut StatusUpdatingEmitter<R>,
    cancel_key: &str,
) -> Result<Collected, Failure> {
    let url = format!("{}{RESPONSES_PATH}", target_url.trim_end_matches('/'));
    // The source's OpenAI/httpx client uses a 300-second per-read timeout
    // (`x-stainless-read-timeout: 300.0` in the recorded request). The
    // `brz-http` default is 400 ms per socket read, which aborts an SSE stream
    // at its first recorded inter-chunk gap (up to ~1.2 s in the recording).
    let client = HttpClient::builder()
        .read_timeout(STREAM_TIMEOUT)
        .build()
        .map_err(|_| Failure::persisted("Connection error.".to_string()))?;
    let payload = dispatch::assemble(request, true, false);
    let body = serde_json::to_value(&payload).unwrap_or(Value::Null);
    let mut response = client
        .post(&url)
        .map_err(|_| Failure::persisted("Connection error.".to_string()))?
        .header("content-type", "application/json")
        .header("accept", dispatch::OPENAI_ACCEPT)
        .header("authorization", dispatch::OPENAI_DUMMY_AUTHORIZATION)
        .header("X-Request-ID", request_id)
        .json(&body)
        .timeout(STREAM_TIMEOUT)
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
    let mut content = String::new();
    let mut event_count = 0_u64;
    let mut terminal = false;
    let mut poll = tokio::time::interval(CANCEL_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    poll.tick().await;

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
            _ = poll.tick() => {
                if is_cancelled(redis, cancel_key).await {
                    return finish_cancelled(state, request, emitter, &content).await;
                }
                continue;
            }
        };
        let chunk = chunk.map_err(|error| Failure::persisted(error.to_string()))?;
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
                    complete(state, &parsed).await;
                    if parsed.event_type == "error" {
                        // The FAILED state is already persisted.
                        drain_terminal_stream(&mut response).await;
                        return Err(Failure {
                            message: parsed
                                .error
                                .clone()
                                .unwrap_or_else(|| "Unknown error".to_string()),
                            persist: false,
                            error_code: None,
                        });
                    }
                } else if let Err(error) = emitter.emit_persist_only(&mut parsed).await {
                    tracing::warn!(%error, "chat-shell stream persistence failed");
                }
            }
            if TERMINAL_EVENT_TYPES.contains(&event_type) {
                terminal = true;
                break;
            }
        }
        if terminal {
            // `_drain_terminal_stream`: the source keeps reading to EOF (up
            // to one second) after a terminal event so the HTTP framing
            // completes; the delivered terminal state is unchanged.
            drain_terminal_stream(&mut response).await;
            break;
        }
    }

    if !terminal {
        return Err(Failure {
            message: format!(
                "Chat Shell SSE stream ended without terminal event after {event_count} events"
            ),
            persist: true,
            error_code: Some("sse_stream_no_terminal"),
        });
    }
    Ok(Collected { content })
}

/// `_drain_terminal_stream`: finish the HTTP response framing after a
/// delivered terminal event by reading the remaining body for up to one
/// second. Read errors are ignored because the terminal state is already
/// persisted and delivered.
pub(super) async fn drain_terminal_stream(response: &mut brz_http::Response) {
    let drain = async { while let Ok(Some(_)) = response.chunk().await {} };
    let _ = tokio::time::timeout(TERMINAL_DRAIN_TIMEOUT, drain).await;
}

/// `StatusUpdatingEmitter`'s terminal branch: collect, persist, publish.
async fn complete(state: &AppState, event: &ExecutionEvent) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let Some(status) = completion::terminal_status(&event.event_type) else {
        return;
    };
    let ctx = completion::Completion {
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    // `StatusUpdatingEmitter`'s terminal branch. The create flow wraps an
    // `SSEResultEmitter`, so the callback's `task:status` owner pre-read does
    // not run here.
    completion::complete_terminal_event(
        &ctx,
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
async fn complete_failure(state: &AppState, request: &ExecutionRequest, failure: &Failure) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let ctx = completion::Completion {
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    completion::complete_terminal_event(
        &ctx,
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
async fn finish_cancelled<R: brz_redis::Redis>(
    state: &AppState,
    request: &ExecutionRequest,
    emitter: &mut StatusUpdatingEmitter<R>,
    content: &str,
) -> Result<Collected, Failure> {
    let event = ExecutionEvent::new(EventType::Cancelled, request.task_id, request.subtask_id);
    emitter.close().await;
    complete(state, &event).await;
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
