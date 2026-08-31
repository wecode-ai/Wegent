// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use tokio::{
    sync::broadcast,
    time::{self, Duration, MissedTickBehavior},
};

use super::RUNTIME_EVENT_BUFFER_CAPACITY;

const EVENT_JOURNAL_MAX_EVENTS: usize = 4096;
const EVENT_JOURNAL_MAX_BYTES: usize = 8 * 1024 * 1024;
const EVENT_ENVELOPE_MAX_BYTES: usize = 256 * 1024;
const EVENT_COALESCE_INTERVAL: Duration = Duration::from_millis(16);
const EVENT_COALESCE_MAX_KEYS: usize = 1024;
const EVENT_METADATA_MAX_CHARS: usize = 256;

#[derive(Clone)]
pub(crate) struct ExecutorEventHub {
    raw_tx: broadcast::Sender<Value>,
    event_tx: broadcast::Sender<Value>,
    state: Arc<Mutex<EventJournal>>,
    started: Arc<AtomicBool>,
}

pub(crate) struct ExecutorEventSubscription {
    pub replay: Vec<Value>,
    pub receiver: broadcast::Receiver<Value>,
    pub resume_after: u64,
}

struct JournalEvent {
    sequence: u64,
    bytes: usize,
    value: Value,
}

struct EventJournal {
    events: VecDeque<JournalEvent>,
    bytes: usize,
    dropped_through: u64,
    next_sequence: u64,
}

impl ExecutorEventHub {
    pub fn new(raw_tx: broadcast::Sender<Value>) -> Self {
        let (event_tx, _) = broadcast::channel(RUNTIME_EVENT_BUFFER_CAPACITY);
        Self {
            raw_tx,
            event_tx,
            state: Arc::new(Mutex::new(EventJournal::new())),
            started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn from_receiver(receiver: broadcast::Receiver<Value>) -> Self {
        let (raw_tx, _) = broadcast::channel(1);
        let hub = Self::new(raw_tx);
        hub.start(receiver);
        hub
    }

    pub fn ensure_started(&self) {
        self.start(self.raw_tx.subscribe());
    }

    fn start(&self, mut receiver: broadcast::Receiver<Value>) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let hub = self.clone();
        tokio::spawn(async move {
            let mut pending = VecDeque::<(String, Value)>::new();
            let mut flush = time::interval(EVENT_COALESCE_INTERVAL);
            flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
            flush.tick().await;
            loop {
                tokio::select! {
                    _ = flush.tick(), if !pending.is_empty() => {
                        hub.flush_pending(&mut pending, None);
                    }
                    result = receiver.recv() => match result {
                        Ok(event) => {
                            if let Some(key) = coalescing_key(&event) {
                                if pending.len() >= EVENT_COALESCE_MAX_KEYS
                                    && !pending.iter().any(|(pending_key, _)| pending_key == &key)
                                {
                                    hub.flush_pending(&mut pending, None);
                                }
                                if let Some((_, pending_event)) = pending
                                    .iter_mut()
                                    .find(|(pending_key, _)| pending_key == &key)
                                {
                                    merge_coalesced_event(pending_event, event);
                                } else {
                                    pending.push_back((key, event));
                                }
                            } else {
                                let task_id = event_task_id(&event);
                                hub.flush_pending(&mut pending, task_id.as_deref());
                                hub.publish(event);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            hub.flush_pending(&mut pending, None);
                            hub.publish(json!({
                                "type": "event",
                                "event": "executor.event_lagged",
                                "payload": {
                                    "skipped": skipped,
                                    "reason": "executor_event_ingress_backpressure",
                                },
                            }));
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            hub.flush_pending(&mut pending, None);
                            return;
                        }
                    }
                }
            }
        });
    }

    pub fn subscribe_live(&self) -> broadcast::Receiver<Value> {
        self.event_tx.subscribe()
    }

    pub fn subscribe_from_now(&self) -> ExecutorEventSubscription {
        let state = self
            .state
            .lock()
            .expect("executor event journal should not be poisoned");
        let receiver = self.event_tx.subscribe();
        ExecutorEventSubscription {
            replay: Vec::new(),
            receiver,
            resume_after: state.latest_sequence(),
        }
    }

    pub fn subscribe_after(&self, after: u64) -> ExecutorEventSubscription {
        let mut state = self
            .state
            .lock()
            .expect("executor event journal should not be poisoned");
        let receiver = self.event_tx.subscribe();
        let latest_sequence = state.latest_sequence();
        let history_lost = after > 0 && (after < state.dropped_through || after > latest_sequence);

        if history_lost {
            let recovery = state.recovery_event(after);
            let resume_after = event_sequence(&recovery).unwrap_or(latest_sequence);
            return ExecutorEventSubscription {
                replay: vec![recovery],
                receiver,
                resume_after,
            };
        }

        let replay = state
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .map(|event| event.value.clone())
            .collect::<Vec<_>>();
        let resume_after = replay
            .last()
            .and_then(event_sequence)
            .unwrap_or(after.max(latest_sequence));
        ExecutorEventSubscription {
            replay,
            receiver,
            resume_after,
        }
    }

    fn publish(&self, raw: Value) {
        let event = {
            let mut state = self
                .state
                .lock()
                .expect("executor event journal should not be poisoned");
            state.append(raw)
        };
        let _ = self.event_tx.send(event);
    }

    fn flush_pending(&self, pending: &mut VecDeque<(String, Value)>, task_id: Option<&str>) {
        let mut retained = VecDeque::new();
        while let Some((key, event)) = pending.pop_front() {
            if task_id.is_none() || event_task_id(&event).as_deref() == task_id {
                self.publish(event);
            } else {
                retained.push_back((key, event));
            }
        }
        *pending = retained;
    }
}

impl EventJournal {
    fn new() -> Self {
        let epoch_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX / 1000)) as u64;
        Self {
            events: VecDeque::new(),
            bytes: 0,
            dropped_through: 0,
            next_sequence: epoch_millis.saturating_mul(1000).max(1),
        }
    }

    fn append(&mut self, raw: Value) -> Value {
        let sequence = self.take_sequence();
        let event = bounded_event_envelope(raw, sequence);
        let bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());

        self.events.push_back(JournalEvent {
            sequence,
            bytes,
            value: event.clone(),
        });
        self.bytes = self.bytes.saturating_add(bytes);
        while self.events.len() > EVENT_JOURNAL_MAX_EVENTS || self.bytes > EVENT_JOURNAL_MAX_BYTES {
            let Some(dropped) = self.events.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped.bytes);
            self.dropped_through = dropped.sequence;
        }
        event
    }

    fn recovery_event(&mut self, requested_after: u64) -> Value {
        let oldest_available = self
            .events
            .front()
            .map(|event| event.sequence)
            .unwrap_or(self.next_sequence);
        let latest_sequence = self.latest_sequence();
        event_envelope(
            json!({
                "type": "event",
                "event": "executor.event_lagged",
                "payload": {
                    "skipped": latest_sequence.saturating_sub(requested_after),
                    "reason": "event_history_lost",
                    "requestedAfter": requested_after,
                    "oldestAvailable": oldest_available,
                    "latestSequence": latest_sequence,
                },
            }),
            self.take_sequence(),
        )
    }

    fn latest_sequence(&self) -> u64 {
        self.next_sequence.saturating_sub(1)
    }

    fn take_sequence(&mut self) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        sequence
    }
}

fn coalescing_key(event: &Value) -> Option<String> {
    let event_name = event.get("event").and_then(Value::as_str)?;
    if !matches!(
        event_name,
        "response.block.updated"
            | "response.subagent.activity"
            | "runtime.plan.updated"
            | "runtime.goal.updated"
            | "thread/tokenUsage/updated"
    ) {
        return None;
    }
    let payload = event.get("payload")?;
    let task_id = payload
        .get("taskId")
        .or_else(|| payload.get("task_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if task_id.is_empty() {
        return None;
    }
    let subtask_id = payload
        .get("subtaskId")
        .or_else(|| payload.get("subtask_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let block_id = payload
        .get("data")
        .and_then(|data| {
            data.get("block_id")
                .or_else(|| data.get("blockId"))
                .or_else(|| data.get("item_id"))
                .or_else(|| data.get("itemId"))
        })
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(format!("{event_name}\0{task_id}\0{subtask_id}\0{block_id}"))
}

fn merge_coalesced_event(pending: &mut Value, next: Value) {
    if merge_block_content_delta(pending, &next) {
        return;
    }
    *pending = next;
}

fn merge_block_content_delta(pending: &mut Value, next: &Value) -> bool {
    if pending.get("event").and_then(Value::as_str) != Some("response.block.updated")
        || next.get("event").and_then(Value::as_str) != Some("response.block.updated")
    {
        return false;
    }
    let Some(current_updates) = pending
        .pointer_mut("/payload/data/updates")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let Some(next_updates) = next
        .pointer("/payload/data/updates")
        .and_then(Value::as_object)
    else {
        return false;
    };
    let Some(current_delta) = current_updates
        .get("content_delta")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    if next_updates.contains_key("content") {
        return false;
    }
    if let Some(next_delta) = next_updates.get("content_delta").and_then(Value::as_str) {
        current_updates.insert(
            "content_delta".to_owned(),
            Value::String(format!("{current_delta}{next_delta}")),
        );
    }
    for (key, value) in next_updates {
        if key != "content_delta" {
            current_updates.insert(key.clone(), value.clone());
        }
    }
    true
}

fn event_task_id(event: &Value) -> Option<String> {
    event
        .get("payload")
        .and_then(|payload| payload.get("taskId").or_else(|| payload.get("task_id")))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(crate) fn event_sequence(event: &Value) -> Option<u64> {
    event.get("sequence").and_then(Value::as_u64)
}

fn event_envelope(raw: Value, sequence: u64) -> Value {
    let event = raw
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("executor.unknown");
    let payload = raw.get("payload").cloned().unwrap_or_else(|| json!({}));
    json!({
        "type": "event",
        "protocolVersion": 1,
        "sequence": sequence,
        "emittedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "event": event,
        "payload": payload,
    })
}

fn bounded_event_envelope(raw: Value, sequence: u64) -> Value {
    let original_event = raw
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("executor.unknown")
        .chars()
        .take(EVENT_METADATA_MAX_CHARS)
        .collect::<String>();
    let task_id = event_task_id(&raw).map(|task_id| {
        task_id
            .chars()
            .take(EVENT_METADATA_MAX_CHARS)
            .collect::<String>()
    });
    let event = event_envelope(raw, sequence);
    let bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());
    if bytes <= EVENT_ENVELOPE_MAX_BYTES {
        return event;
    }
    let replacement = event_envelope(
        json!({
            "type": "event",
            "event": "executor.event_lagged",
            "payload": {
                "reason": "event_too_large",
                "originalEvent": original_event,
                "originalBytes": bytes,
                "taskId": task_id,
                "latestSequence": sequence,
            },
        }),
        sequence,
    );
    if serde_json::to_vec(&replacement).map_or(usize::MAX, |encoded| encoded.len())
        <= EVENT_ENVELOPE_MAX_BYTES
    {
        return replacement;
    }
    event_envelope(
        json!({
            "type": "event",
            "event": "executor.event_lagged",
            "payload": {
                "reason": "event_too_large",
                "originalBytes": bytes,
                "latestSequence": sequence,
            },
        }),
        sequence,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        coalescing_key, event_sequence, EventJournal, ExecutorEventHub, EVENT_ENVELOPE_MAX_BYTES,
        EVENT_JOURNAL_MAX_EVENTS,
    };
    use serde_json::json;
    use tokio::sync::broadcast;

    #[test]
    fn journal_bounds_events_and_reports_history_loss() {
        let mut journal = EventJournal::new();
        let first = journal.append(json!({"event": "response.created", "payload": {}}));
        let first_sequence = event_sequence(&first).unwrap();
        for index in 0..EVENT_JOURNAL_MAX_EVENTS {
            journal.append(json!({
                "event": "response.output_text.delta",
                "payload": {"data": {"delta": index.to_string()}},
            }));
        }

        let recovery = journal.recovery_event(first_sequence.saturating_sub(1));

        assert_eq!(journal.dropped_through, first_sequence);
        assert_eq!(recovery["event"], "executor.event_lagged");
        assert_eq!(recovery["payload"]["reason"], "event_history_lost");
        assert!(event_sequence(&recovery).unwrap() > first_sequence);
    }

    #[test]
    fn oversized_event_becomes_a_bounded_lag_event() {
        let mut journal = EventJournal::new();
        let event = journal.append(json!({
            "event": "response.block.updated",
            "payload": {
                "taskId": "task-1",
                "data": {"content": "x".repeat(EVENT_ENVELOPE_MAX_BYTES)}
            },
        }));

        assert_eq!(event["event"], "executor.event_lagged");
        assert_eq!(event["payload"]["reason"], "event_too_large");
        assert_eq!(event["payload"]["taskId"], "task-1");
        assert_eq!(journal.events.len(), 1);
    }

    #[test]
    fn oversized_event_metadata_cannot_overflow_the_replacement() {
        let mut journal = EventJournal::new();
        let event = journal.append(json!({
            "event": "e".repeat(EVENT_ENVELOPE_MAX_BYTES),
            "payload": {
                "taskId": "t".repeat(EVENT_ENVELOPE_MAX_BYTES),
                "data": {"content": "x".repeat(EVENT_ENVELOPE_MAX_BYTES)}
            },
        }));

        assert_eq!(event["event"], "executor.event_lagged");
        assert!(
            serde_json::to_vec(&event).unwrap().len() <= EVENT_ENVELOPE_MAX_BYTES,
            "replacement event must respect the downstream envelope limit"
        );
    }

    #[test]
    fn block_updates_coalesce_per_task_and_block() {
        let first = json!({
            "event": "response.block.updated",
            "payload": {
                "taskId": "task-1",
                "subtaskId": "turn-1",
                "data": {"block_id": "block-1"}
            }
        });
        let second = json!({
            "event": "response.block.updated",
            "payload": {
                "taskId": "task-2",
                "subtaskId": "turn-1",
                "data": {"block_id": "block-1"}
            }
        });

        assert_ne!(coalescing_key(&first), coalescing_key(&second));
    }

    #[tokio::test]
    async fn latest_block_update_is_flushed_before_terminal_event() {
        let (raw_tx, _) = broadcast::channel(8);
        let hub = ExecutorEventHub::new(raw_tx.clone());
        hub.ensure_started();
        let mut events = hub.subscribe_live();
        for content in ["first", "second"] {
            raw_tx
                .send(json!({
                    "event": "response.block.updated",
                    "payload": {
                        "taskId": "task-1",
                        "subtaskId": "turn-1",
                        "data": {
                            "block_id": "block-1",
                            "updates": {"content": content}
                        }
                    }
                }))
                .unwrap();
        }
        raw_tx
            .send(json!({
                "event": "response.completed",
                "payload": {"taskId": "task-1", "subtaskId": "turn-1"}
            }))
            .unwrap();

        let update = events.recv().await.unwrap();
        let terminal = events.recv().await.unwrap();

        assert_eq!(update["payload"]["data"]["updates"]["content"], "second");
        assert_eq!(terminal["event"], "response.completed");
        assert!(event_sequence(&terminal).unwrap() > event_sequence(&update).unwrap());
    }

    #[tokio::test]
    async fn block_content_deltas_are_concatenated_before_flush() {
        let (raw_tx, _) = broadcast::channel(8);
        let hub = ExecutorEventHub::new(raw_tx.clone());
        hub.ensure_started();
        let mut events = hub.subscribe_live();
        for content_delta in ["first", "second"] {
            raw_tx
                .send(json!({
                    "event": "response.block.updated",
                    "payload": {
                        "taskId": "task-1",
                        "subtaskId": "turn-1",
                        "data": {
                            "block_id": "block-1",
                            "updates": {
                                "content_delta": content_delta,
                                "status": "streaming"
                            }
                        }
                    }
                }))
                .unwrap();
        }
        raw_tx
            .send(json!({
                "event": "response.completed",
                "payload": {"taskId": "task-1", "subtaskId": "turn-1"}
            }))
            .unwrap();

        let update = events.recv().await.unwrap();
        let terminal = events.recv().await.unwrap();

        assert_eq!(
            update["payload"]["data"]["updates"]["content_delta"],
            "firstsecond"
        );
        assert_eq!(terminal["event"], "response.completed");
    }

    #[tokio::test]
    async fn terminal_block_status_preserves_pending_content_delta() {
        let (raw_tx, _) = broadcast::channel(8);
        let hub = ExecutorEventHub::new(raw_tx.clone());
        hub.ensure_started();
        let mut events = hub.subscribe_live();
        raw_tx
            .send(json!({
                "event": "response.block.updated",
                "payload": {
                    "taskId": "task-1",
                    "subtaskId": "turn-1",
                    "data": {
                        "block_id": "block-1",
                        "updates": {
                            "content_delta": "last chunk",
                            "status": "streaming"
                        }
                    }
                }
            }))
            .unwrap();
        raw_tx
            .send(json!({
                "event": "response.block.updated",
                "payload": {
                    "taskId": "task-1",
                    "subtaskId": "turn-1",
                    "data": {
                        "block_id": "block-1",
                        "updates": {"status": "done"}
                    }
                }
            }))
            .unwrap();
        raw_tx
            .send(json!({
                "event": "response.completed",
                "payload": {"taskId": "task-1", "subtaskId": "turn-1"}
            }))
            .unwrap();

        let update = events.recv().await.unwrap();

        assert_eq!(
            update["payload"]["data"]["updates"]["content_delta"],
            "last chunk"
        );
        assert_eq!(update["payload"]["data"]["updates"]["status"], "done");
    }
}
