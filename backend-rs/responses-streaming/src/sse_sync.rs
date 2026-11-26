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

use brz_http::Client as HttpClient;
use brz_redis::Redis;
use serde_json::Value;
use wegent_execution_emission::{
    LocalEmit,
    emitter::{CreatedTask, StatusUpdatingEmitter},
};
use wegent_execution_events::{
    event::{EventType, ExecutionEvent, terminal_status},
    parser,
};
use wegent_execution_runtime::stream_state::{register_stream, unregister_stream};
use wegent_protocol::dispatch::{self, ExecutionRequest};

use crate::polling::{poll_cancellation, poll_once};
pub use crate::sse_acceptance::DispatchAcceptance;
pub use crate::sse_protocol::Collected;
use crate::sse_protocol::{
    Failure, RESPONSES_PATH, STREAM_TIMEOUT, SseFrames, TERMINAL_EVENT_TYPES,
};
use crate::transport::{drain_terminal_stream, stream_request, stream_transport_error};

/// Side effects that require the gateway's execution completion and notifications.
#[allow(async_fn_in_trait)]
pub trait ExecutionLifecycle: Send + Sync {
    async fn complete(&self, event: &ExecutionEvent) -> Result<(), Failure>;
    async fn complete_failure(&self, request: &ExecutionRequest, failure: &Failure);
    async fn emit_package_event(&self, event: &ExecutionEvent) -> Result<(), Failure>;
    async fn persist_timing(&self, event: &ExecutionEvent);
}

/// Transports, forwarding preferences, and lifecycle for one synchronous SSE consumer.
pub struct ConsumerContext<'a, R: Redis, L: LocalEmit, H: ExecutionLifecycle> {
    pub host: &'a H,
    pub local: L,
    pub package_mode: bool,
    pub redis: Option<&'a R>,
    pub forward: bool,
    pub start_data: &'a Value,
    pub created_task: Option<&'a CreatedTask>,
    pub acceptance: Option<&'a DispatchAcceptance>,
}

/// Consume one chat-shell event stream for the synchronous create branch.
///
/// The returned error message is the source's `str(exception)` rendered into
/// `500 {"detail": "LLM request failed: <message>"}` by the caller.
pub async fn collect<R: Redis + Clone, L: LocalEmit + Clone, H: ExecutionLifecycle>(
    ctx: &ConsumerContext<'_, R, L, H>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
) -> Result<Collected, String> {
    let Some(redis) = ctx.redis else {
        return Err("Connection error.".to_string());
    };

    let mut emitter = StatusUpdatingEmitter::with_local_emit(
        redis.clone(),
        request.task_id,
        request.subtask_id,
        ctx.local.clone(),
    );
    if let Some(created) = ctx.created_task.cloned() {
        emitter = emitter.with_created_task(created);
    }
    let cancel_key = wegent_execution_runtime::stream_state::cancel_key(request.subtask_id);
    // A package job starts after the public request has returned or subscribed.
    // Clearing its flag here could erase a cancellation admitted while queued.
    let image_stream = super::package_runtime::is_image_target(target_url);
    if !ctx.package_mode && !image_stream && ctx.acceptance.is_none() {
        register_stream(Some(redis), request.subtask_id).await;
    }

    let result = read_stream(
        ctx,
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
    unregister_stream(Some(redis), request.subtask_id).await;

    match result {
        Ok((collected, terminal)) => {
            if let Some(event) = terminal {
                // A terminal image row makes its subtask ID available for retry.
                // All old cancel-key operations must finish before that handoff.
                ctx.host
                    .complete(&event)
                    .await
                    .map_err(|error| error.message)?;
                if event.event_type == "error" {
                    return Err(event.error.unwrap_or_else(|| "Unknown error".to_string()));
                }
            }
            Ok(collected)
        }
        Err(failure) => {
            if ctx
                .acceptance
                .as_ref()
                .is_some_and(|value| value.resolve(Err(failure.message.clone())))
            {
                return Err(failure.message);
            }
            // An automatic handoff can replay this stream after transport loss.
            // Explicit upstream terminal frames still settle through complete().
            if failure.persist && ctx.acceptance.is_none() {
                ctx.host.complete_failure(request, &failure).await;
            }
            Err(failure.message)
        }
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
    /// The image stream's terminal event is persisted after releasing its cancel key.
    ImageTerminal(brz_http::Response, Box<ExecutionEvent>),
}

#[allow(clippy::too_many_arguments)]
async fn read_stream<R: Redis, L: LocalEmit, H: ExecutionLifecycle>(
    ctx: &ConsumerContext<'_, R, L, H>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    redis: &R,
    emitter: &mut StatusUpdatingEmitter<R, L>,
    cancel_key: &str,
) -> Result<(Collected, Option<ExecutionEvent>), Failure> {
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

    // `_dispatch_chat_shell_sse`'s `await emitter.emit_start(...)` runs after
    // the cancellation watcher is created and before the stream opens. The
    // wrapped emitter publishes the START frames without persisting, so the
    // `chat:task_streaming` marker is established only by the parsed
    // `response.created` START inside the consume loop.
    let image_stream = super::package_runtime::is_image_target(target_url);
    if ctx.forward
        && !image_stream
        && let Err(error) = emitter
            .emit_start_forward_only(message_id, ctx.start_data)
            .await
    {
        tracing::warn!(%error, "chat-shell START emit failed");
    }

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
        );
        tokio::pin!(open);
        if already_cancelled {
            // The Source still creates `stream_open_task` before waiting on the
            // race and then drops it through `_cancel_sse_stream_open`; start
            // the request so an in-flight open is not skipped.
            if !ctx.package_mode && !image_stream {
                let _ = poll_once(open.as_mut()).await;
            }
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
        None => {
            let event =
                ExecutionEvent::new(EventType::Cancelled, request.task_id, request.subtask_id);
            if image_stream {
                Ok((Collected { content }, Some(event)))
            } else {
                emitter.close().await;
                ctx.host
                    .complete(&event)
                    .await
                    .map(|()| (Collected { content }, None))
            }
        }
        Some(Ok(StreamEnd::Terminal(mut response))) => {
            cancel_done |= drain_with_cancel_poll(&mut response, cancel.as_mut()).await;
            Ok((Collected { content }, None))
        }
        Some(Ok(StreamEnd::ErrorTerminal(mut response, failure))) => {
            cancel_done |= drain_with_cancel_poll(&mut response, cancel.as_mut()).await;
            Err(failure)
        }
        Some(Ok(StreamEnd::ImageTerminal(mut response, event))) => {
            cancel_done |= drain_with_cancel_poll(&mut response, cancel.as_mut()).await;
            Ok((Collected { content }, Some(*event)))
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
async fn open_and_consume<R: Redis, L: LocalEmit, H: ExecutionLifecycle>(
    ctx: &ConsumerContext<'_, R, L, H>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
    emitter: &mut StatusUpdatingEmitter<R, L>,
    content: &mut String,
) -> Result<StreamEnd, Failure> {
    let image_stream = super::package_runtime::is_image_target(target_url);
    let (url, body) = if image_stream {
        (target_url.to_owned(), image_request_body(request))
    } else {
        let payload = dispatch::assemble(request, true, false);
        (
            format!("{}{RESPONSES_PATH}", target_url.trim_end_matches('/')),
            serde_json::to_value(&payload).unwrap_or(Value::Null),
        )
    };
    // The source's OpenAI/httpx client uses a 300-second per-read timeout
    // (`x-stainless-read-timeout: 300.0` in the recorded request). The
    // `brz-http` default is 400 ms per socket read, which aborts an SSE stream
    // at its first recorded inter-chunk gap (up to ~1.2 s in the recording).
    let client = HttpClient::builder()
        .read_timeout(STREAM_TIMEOUT)
        .build()
        .map_err(|_| Failure::network("Connection error.".to_string()))?;
    let http_request = stream_request(&client, &url, &body, request_id)
        .map_err(|_| Failure::network("Connection error.".to_string()))?;
    let mut response = client
        .execute(http_request)
        .await
        .map_err(|_| Failure::network("Connection error.".to_string()))?;

    if !response.status().is_success() {
        return Err(Failure::persisted(format!(
            "HTTP status code: {}",
            response.status().as_u16()
        )));
    }

    if image_stream {
        tracing::info!(
            task_id = request.task_id,
            subtask_id = request.subtask_id,
            "Image execution SSE stream opened"
        );
    } else {
        tracing::info!(
            task_id = request.task_id,
            subtask_id = request.subtask_id,
            "Chat Shell SSE stream opened"
        );
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
            .map_err(|error| Failure::persisted(stream_transport_error(&error, STREAM_TIMEOUT)))?;
        let Some(chunk) = chunk else { break };
        for event in frames.push(&chunk) {
            event_count += 1;
            let Some(event_type) = event.get("type").and_then(Value::as_str) else {
                continue;
            };
            let parsed = if image_stream {
                Some(parse_image_event(&event, request, ctx.start_data)?)
            } else {
                parser::shared()
                    .parse(
                        request.task_id,
                        request.subtask_id,
                        message_id,
                        event_type,
                        &event,
                    )
                    .map_err(|error| Failure::persisted(error.0))?
            };
            if let Some(mut parsed) = parsed {
                if let Some(acceptance) = ctx.acceptance {
                    acceptance
                        .accept(ctx.redis.ok_or_else(|| {
                            Failure::terminal_persistence("Pipeline Redis is unavailable")
                        })?)
                        .await
                        .map_err(|error| Failure::terminal_persistence(&error))?;
                }
                if image_stream && let Some(redis) = ctx.redis {
                    persist_image_blocks(redis, &parsed).await;
                }
                if parsed.event_type == "chunk" {
                    content.push_str(&parsed.content);
                }
                if !ctx.package_mode {
                    ctx.host.persist_timing(&parsed).await;
                }
                if terminal_status(&parsed.event_type).is_some() {
                    if image_stream {
                        return Ok(StreamEnd::ImageTerminal(response, Box::new(parsed)));
                    }
                    // `StatusUpdatingEmitter`'s terminal branch flushes the
                    // buffered stream content before completing the task.
                    emitter.close().await;
                    ctx.host.complete(&parsed).await?;
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
                } else if ctx.package_mode {
                    ctx.host.emit_package_event(&parsed).await?;
                } else if ctx.forward {
                    // `/chat` dispatch: `WebSocketResultEmitter.emit`, i.e.
                    // persist and publish the corresponding Socket.IO frame.
                    if let Err(error) = emitter.emit(&mut parsed).await {
                        tracing::warn!(%error, "chat-shell stream forward failed");
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
        // `classify_error` falls back to `generic_error` for an exception it
        // cannot match by type or message (`shared/utils/error_classifier.py`).
        error_code: Some("generic_error"),
    })
}

/// Only send the fields ImageAgent consumes across the private runtime boundary.
fn image_request_body(request: &ExecutionRequest) -> Value {
    serde_json::json!({
        "task_id": request.task_id,
        "subtask_id": request.subtask_id,
        "user_subtask_id": request.user_subtask_id,
        "message_id": request.message_id,
        "user": { "id": request.user_id },
        "prompt": request.prompt,
        "attachments": request.attachments,
        "model_config": request.model_config,
    })
}

fn parse_image_event(
    payload: &Value,
    request: &ExecutionRequest,
    start_data: &Value,
) -> Result<ExecutionEvent, Failure> {
    let mut event = ExecutionEvent::from_value(payload);
    if event.task_id != request.task_id || event.subtask_id != request.subtask_id {
        return Err(Failure::persisted(
            "Image execution returned an event for a different turn".to_owned(),
        ));
    }
    if event.event_type == "start"
        && let Some(bot_name) = start_data.get("bot_name")
    {
        event.data.insert("bot_name".into(), bot_name.clone());
    }
    Ok(event)
}

/// Keep the placeholder and final snapshot available to reconnecting clients.
async fn persist_image_blocks<R: Redis>(redis: &R, event: &ExecutionEvent) {
    let Some(blocks) = event
        .result
        .as_ref()
        .and_then(|result| result["blocks"].as_array())
    else {
        return;
    };
    for block in blocks.iter().filter(|block| block["type"] == "image") {
        if let Some(mut block) = block.as_object().cloned()
            && let Err(error) =
                wegent_execution_runtime::session::add_block(redis, event.subtask_id, &mut block)
                    .await
        {
            tracing::warn!(%error, subtask_id = event.subtask_id, "image block persistence failed");
        }
    }
}

/// Build the Chat Shell SSE request without a total request deadline.
///
/// `read_timeout` on the client bounds inactivity between chunks. A request
/// deadline would also cap healthy streams that keep producing events.
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

#[cfg(test)]
use crate::sse_protocol::parse_frame;

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded a4130073 seq95: the dispatcher's `except` branch persists a
    /// transport failure as `result='{"error_type": "network_error"}'`
    /// (`classify_error` + `collect_completed_result`), not a NULL result.
    #[test]
    fn a_persisted_failure_carries_the_classified_error_type() {
        let network = Failure::network("Connection error.".to_string());
        assert_eq!(
            network.result(),
            Some(serde_json::json!({"error_type": "network_error"}))
        );
        // A terminal error event was already persisted by its emitter, and a
        // failure without a classified code writes no result column.
        let already_persisted = Failure {
            message: "terminal error".to_string(),
            persist: false,
            error_code: None,
        };
        assert_eq!(already_persisted.result(), None);
        assert_eq!(Failure::persisted("boom".to_string()).result(), None);
    }

    #[test]
    fn image_runtime_preserves_reference_input_and_terminal_image_blocks() {
        let request = ExecutionRequest {
            task_id: 5,
            subtask_id: 6,
            message_id: Some(2),
            user_id: 7,
            prompt: serde_json::json!("Draw a blue square"),
            attachments: vec![serde_json::json!({"mime_type": "image/png", "url": "reference"})],
            model_config: serde_json::json!({"modelType": "image", "protocol": "gpt-image"}),
            ..ExecutionRequest::default()
        };
        let body = image_request_body(&request);
        assert_eq!(body["user"]["id"], 7);
        assert_eq!(body["model_config"]["protocol"], "gpt-image");
        assert_eq!(body["attachments"][0]["url"], "reference");
        assert!(body.get("auth_token").is_none());

        let mut frames = SseFrames::default();
        let events = frames.push(
            b"data: {\"type\":\"done\",\"task_id\":5,\"subtask_id\":6,\"message_id\":2,\"result\":{\"blocks\":[{\"type\":\"image\",\"image_attachment_ids\":[41]}]}}\n\n",
        );
        let event = parse_image_event(&events[0], &request, &Value::Null)
            .ok()
            .expect("valid ImageAgent event");
        assert_eq!(terminal_status(&event.event_type), Some("COMPLETED"));
        assert_eq!(event.message_id, Some(2));
        assert_eq!(
            event.result.unwrap()["blocks"][0]["image_attachment_ids"][0],
            41
        );
        assert!(parse_image_event(&events[0], &ExecutionRequest::default(), &Value::Null).is_err());
    }

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
