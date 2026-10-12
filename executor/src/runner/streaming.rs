// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::{ready, Ready},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::{
    sync::{
        mpsc::{unbounded_channel, UnboundedSender},
        oneshot, watch,
    },
    task::AbortHandle,
};

use crate::{emitter::EventEnvelope, logging::log_executor_event, runner::EventSink};

#[cfg(test)]
#[path = "streaming_tests.rs"]
mod tests;

const MAX_LIVE_COMPACTED_EVENTS: usize = 256;
const DELTA_BATCH_WINDOW: Duration = Duration::from_millis(75);

#[derive(Clone)]
pub(crate) struct StreamingEventDispatcher {
    sender: UnboundedSender<QueuedStreamEvent>,
    pending: Arc<AtomicUsize>,
    compact_pending: Arc<AtomicBool>,
    failure: watch::Receiver<Option<String>>,
    worker: AbortHandle,
}

enum QueuedStreamEvent {
    Callback {
        event: Box<EventEnvelope>,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        compactable: bool,
        queued_at: Instant,
    },
    Flush {
        done: oneshot::Sender<()>,
    },
}

struct CompactedStreamEvent {
    event: EventEnvelope,
    text: Option<String>,
    text_chars: usize,
    input_events: usize,
}

fn compact_stream_event(
    compacted: &mut Option<CompactedStreamEvent>,
    event: Box<EventEnvelope>,
) -> Result<(), Box<EventEnvelope>> {
    if let Some(existing) = compacted.as_mut() {
        if existing.event.event_type != event.event_type
            || existing.event.task_id != event.task_id
            || existing.event.subtask_id != event.subtask_id
            || existing.event.message_id != event.message_id
        {
            return Err(event);
        }
        if let (Some(text), Some(delta)) = (existing.text.as_mut(), event.data["delta"].as_str()) {
            if existing.event.data["item_id"] != event.data["item_id"]
                || existing.event.data["content_index"] != event.data["content_index"]
                || existing.event.data["output_index"] != event.data["output_index"]
                || existing.event.data["block_offset"]
                    .as_u64()
                    .map(|offset| offset + existing.text_chars as u64)
                    != event.data["block_offset"].as_u64()
                || existing.event.data["offset"]
                    .as_u64()
                    .map(|offset| offset + existing.text_chars as u64)
                    != event.data["offset"].as_u64()
            {
                return Err(event);
            }
            text.push_str(delta);
            existing.text_chars += delta.chars().count();
            existing.input_events += 1;
            return Ok(());
        }
        if event.event_type == "response.block.updated"
            && existing.event.data["block_id"] == event.data["block_id"]
        {
            existing.event.data["updates"]
                .as_object_mut()
                .unwrap()
                .extend(event.data["updates"].as_object().unwrap().clone());
            existing.input_events += 1;
            return Ok(());
        }
        return Err(event);
    }
    let text = event
        .data
        .get("delta")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let event = *event;
    let text_chars = text.as_ref().map_or(0, |text| text.chars().count());
    *compacted = Some(CompactedStreamEvent {
        event,
        text,
        text_chars,
        input_events: 1,
    });
    Ok(())
}

async fn send_compacted_event<S>(
    sink: &S,
    compacted: &mut Option<CompactedStreamEvent>,
    failure: &watch::Sender<Option<String>>,
) where
    S: EventSink,
{
    let Some(mut compacted) = compacted.take() else {
        return;
    };
    let text_chars = compacted.text_chars;
    let is_text = compacted.text.is_some();
    if let Some(text) = compacted.text {
        compacted.event.data["delta"] = Value::String(text);
    }
    let task_id = compacted.event.task_id.clone();
    let subtask_id = compacted.event.subtask_id.clone();
    let event_type = compacted.event.event_type.clone();
    let started = Instant::now();
    if let Err(message) = sink.send(compacted.event).await {
        let fields = vec![
            ("task_id", task_id.clone()),
            ("subtask_id", subtask_id.clone()),
            ("error_len", message.len().to_string()),
        ];
        log_executor_event("streaming compacted callback failed", &fields);
        failure.send_replace(Some(message));
    }
    let fields = vec![
        ("task_id", task_id),
        ("subtask_id", subtask_id),
        ("text_chars", text_chars.to_string()),
        ("input_events", compacted.input_events.to_string()),
        ("event_type", event_type),
        ("elapsed_ms", started.elapsed().as_millis().to_string()),
    ];
    log_executor_event(
        if is_text {
            "streaming compacted text emitted"
        } else {
            "streaming compacted block emitted"
        },
        &fields,
    );
}

impl StreamingEventDispatcher {
    pub(crate) fn new<S>(sink: S) -> Self
    where
        S: EventSink,
    {
        Self::with_compaction(sink, false, Some(DELTA_BATCH_WINDOW))
    }

    pub(crate) fn with_live_compaction<S>(sink: S) -> Self
    where
        S: EventSink,
    {
        Self::with_compaction(sink, true, None)
    }

    fn with_compaction<S>(
        sink: S,
        compact_while_streaming: bool,
        batch_window: Option<Duration>,
    ) -> Self
    where
        S: EventSink,
    {
        let (sender, mut receiver) = unbounded_channel::<QueuedStreamEvent>();
        let pending = Arc::new(AtomicUsize::new(0));
        let worker_pending = Arc::clone(&pending);
        let compact_pending = Arc::new(AtomicBool::new(compact_while_streaming));
        let worker_compact_pending = Arc::clone(&compact_pending);
        let (failure_sender, failure) = watch::channel(None);
        let worker = tokio::spawn(async move {
            let mut compacted_event: Option<CompactedStreamEvent> = None;
            let mut first_text_dispatched = false;
            let mut first_reasoning_dispatched = false;
            let mut batch_deadline = tokio::time::Instant::now();
            loop {
                let queued = tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(batch_deadline),
                        if batch_window.is_some() && compacted_event.is_some()
                            && !worker_compact_pending.load(Ordering::Relaxed) => {
                        send_compacted_event(&sink, &mut compacted_event, &failure_sender).await;
                        continue;
                    }
                    queued = receiver.recv() => queued,
                };
                let Some(queued) = queued else {
                    send_compacted_event(&sink, &mut compacted_event, &failure_sender).await;
                    break;
                };
                match queued {
                    QueuedStreamEvent::Callback {
                        event,
                        log_name,
                        fields,
                        compactable,
                        queued_at,
                    } => {
                        let first_delta = match event.event_type.as_str() {
                            "response.output_text.delta" => !first_text_dispatched,
                            "response.reasoning_summary_text.delta" => !first_reasoning_dispatched,
                            _ => false,
                        };
                        let compact_now = worker_compact_pending.load(Ordering::Relaxed);
                        let event = if compactable
                            && (compact_now || (batch_window.is_some() && !first_delta))
                        {
                            if compacted_event.is_none() {
                                batch_deadline =
                                    tokio::time::Instant::now() + batch_window.unwrap_or_default();
                            }
                            match compact_stream_event(&mut compacted_event, event) {
                                Ok(()) => {
                                    worker_pending.fetch_sub(1, Ordering::Relaxed);
                                    // Send the latest queued progress without waiting for
                                    // the turn to end or for another event to arrive.
                                    // Bound each batch so continuous input cannot starve it.
                                    if (compact_while_streaming && receiver.is_empty())
                                        || ((compact_while_streaming || !compact_now)
                                            && compacted_event.as_ref().is_some_and(|event| {
                                                event.input_events >= MAX_LIVE_COMPACTED_EVENTS
                                            }))
                                    {
                                        send_compacted_event(
                                            &sink,
                                            &mut compacted_event,
                                            &failure_sender,
                                        )
                                        .await;
                                    }
                                    continue;
                                }
                                Err(original_event) => original_event,
                            }
                        } else {
                            event
                        };
                        send_compacted_event(&sink, &mut compacted_event, &failure_sender).await;
                        let event = *event;
                        let started = Instant::now();
                        let queue_wait_ms = started.duration_since(queued_at).as_millis();
                        let event_type = event.event_type.clone();
                        let first_text =
                            !first_text_dispatched && event_type == "response.output_text.delta";
                        first_text_dispatched |= first_text;
                        first_reasoning_dispatched |=
                            event_type == "response.reasoning_summary_text.delta";
                        let task_id = event.task_id.clone();
                        let subtask_id = event.subtask_id.clone();
                        let message_id = event.message_id.map(|value| value.to_string());
                        if let Err(message) = sink.send(event).await {
                            let mut fields = fields;
                            fields.push(("error_len", message.len().to_string()));
                            log_executor_event(log_name, &fields);
                            failure_sender.send_replace(Some(message));
                        }
                        let remaining = worker_pending
                            .fetch_sub(1, Ordering::Relaxed)
                            .saturating_sub(1);
                        let elapsed_ms = started.elapsed().as_millis();
                        if first_text || elapsed_ms >= 1_000 || queue_wait_ms >= 1_000 {
                            let fields = vec![
                                ("task_id", task_id),
                                ("subtask_id", subtask_id),
                                ("event_type", event_type),
                                ("elapsed_ms", elapsed_ms.to_string()),
                                ("queue_wait_ms", queue_wait_ms.to_string()),
                                ("pending_depth", remaining.to_string()),
                                ("message_id", message_id.unwrap_or_default()),
                            ];
                            log_executor_event(
                                if first_text {
                                    "streaming first text dispatch finished"
                                } else {
                                    "streaming callback dispatch slow"
                                },
                                &fields,
                            );
                        }
                    }
                    QueuedStreamEvent::Flush { done } => {
                        send_compacted_event(&sink, &mut compacted_event, &failure_sender).await;
                        let _ = done.send(());
                    }
                }
            }
        });
        Self {
            sender,
            pending,
            compact_pending,
            failure,
            worker: worker.abort_handle(),
        }
    }

    pub(crate) fn abort(&self) {
        self.worker.abort();
    }

    pub(crate) async fn failed(&self) -> String {
        let mut failure = self.failure.clone();
        loop {
            if let Some(message) = failure.borrow().clone() {
                return message;
            }
            if failure.changed().await.is_err() {
                return "streaming callback queue closed".to_owned();
            }
        }
    }

    pub(crate) fn result(&self) -> Result<(), String> {
        match self.failure.borrow().clone() {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    pub(crate) async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.sender.send(QueuedStreamEvent::Flush { done }).is_err() {
            log_executor_event("streaming callback queue closed", &[]);
            return;
        }
        let _ = wait.await;
    }

    pub(crate) async fn compact_pending_and_flush(&self, task_id: &str, subtask_id: &str) {
        self.compact_pending.store(true, Ordering::Relaxed);
        let fields = vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            (
                "pending_depth",
                self.pending.load(Ordering::Relaxed).to_string(),
            ),
        ];
        log_executor_event("streaming callback queue compaction requested", &fields);
        self.flush().await;
    }

    pub(crate) fn send(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
    ) {
        self.send_internal(event, log_name, fields, false);
    }

    pub(crate) fn send_text_delta(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        text_delta_chars: usize,
    ) {
        self.send_internal(event, log_name, fields, text_delta_chars > 0);
    }

    fn send_internal(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        compactable: bool,
    ) {
        let depth = self.pending.fetch_add(1, Ordering::Relaxed) + 1;
        if depth % 100 == 0 {
            let mut queue_fields = fields.clone();
            queue_fields.push(("pending_depth", depth.to_string()));
            queue_fields.push(("event_type", event.event_type.clone()));
            log_executor_event("streaming callback queue depth", &queue_fields);
        }
        if self
            .sender
            .send(QueuedStreamEvent::Callback {
                event: Box::new(event),
                log_name,
                fields,
                compactable,
                queued_at: Instant::now(),
            })
            .is_err()
        {
            self.pending.fetch_sub(1, Ordering::Relaxed);
            log_executor_event("streaming callback queue closed", &[]);
        }
    }
}

impl EventSink for StreamingEventDispatcher {
    type SendFuture = Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        if let Err(message) = self.result() {
            return ready(Err(message));
        }
        // Codex projects block deltas into snapshots before enqueueing them.
        // Only adjacent updates to the same block may replace older snapshots.
        let compactable = match event.event_type.as_str() {
            "response.output_text.delta" => event.data["delta"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            "response.block.updated" => {
                event.data["block_id"].is_string()
                    && event.data["updates"]
                        .as_object()
                        .is_some_and(|updates| updates.keys().all(|key| !key.ends_with("_delta")))
            }
            _ => false,
        };
        let fields = vec![
            ("task_id", event.task_id.clone()),
            ("subtask_id", event.subtask_id.clone()),
        ];
        self.send_internal(event, "streaming callback failed", fields, compactable);
        ready(Ok(()))
    }
}
