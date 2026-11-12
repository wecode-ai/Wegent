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

use super::terminal_event_journal::{is_terminal, TerminalEventJournal};
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
    backend_tx: broadcast::Sender<Value>,
    state: Arc<Mutex<EventJournal>>,
    started: Arc<AtomicBool>,
    terminal_events: Arc<Mutex<TerminalEventJournal>>,
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
        let (backend_tx, _) = broadcast::channel(RUNTIME_EVENT_BUFFER_CAPACITY);
        Self {
            raw_tx,
            event_tx,
            backend_tx,
            state: Arc::new(Mutex::new(EventJournal::new())),
            started: Arc::new(AtomicBool::new(false)),
            terminal_events: Arc::new(Mutex::new(TerminalEventJournal::default())),
        }
    }

    pub fn from_receiver(receiver: broadcast::Receiver<Value>) -> Self {
        let (raw_tx, _) = broadcast::channel(1);
        let hub = Self::new(raw_tx);
        hub.start(receiver);
        hub
    }

    pub fn enable_terminal_event_journal(&self, directory: std::path::PathBuf) {
        self.terminal_events
            .lock()
            .expect("terminal event journal lock")
            .enable(directory);
    }

    pub fn subscribe_backend(&self, after: u64) -> ExecutorEventSubscription {
        let receiver = self.backend_tx.subscribe();
        let mut subscription = self.subscribe_after(after);
        subscription.receiver = receiver;
        // Terminal delivery has its own durable queue and acknowledgement
        // lifecycle, independent of the streaming replay cursor.
        subscription.replay.retain(|event| !is_terminal(event));
        subscription
    }

    pub fn pending_backend_terminals(&self) -> Result<Vec<Value>, String> {
        self.terminal_events
            .lock()
            .expect("terminal event journal lock")
            .pending()
    }

    pub fn acknowledge_backend(&self, event: &Value) -> Result<(), String> {
        self.terminal_events
            .lock()
            .expect("terminal event journal lock")
            .acknowledge(event)
    }

    pub fn bind_backend_journal(&self, scope: String) {
        let loaded = self
            .terminal_events
            .lock()
            .expect("terminal event journal lock")
            .bind(scope);
        match loaded {
            Ok(last) => {
                let mut state = self.state.lock().expect("executor event journal lock");
                state.next_sequence = state.next_sequence.max(last.saturating_add(1));
            }
            Err(error) => crate::logging::write_executor_error_line(&error),
        }
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
                                let merged = pending
                                    .iter_mut()
                                    .find(|(pending_key, _)| pending_key == &key)
                                    .map(|(_, pending_event)| merge_coalesced_event(pending_event, &event));
                                if merged == Some(false) {
                                    hub.flush_pending(&mut pending, event_task_id(&event).as_deref());
                                }
                                if merged != Some(true) {
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
        let (event, backend_event) = {
            let mut state = self
                .state
                .lock()
                .expect("executor event journal should not be poisoned");
            state.append(raw)
        };
        if let Err(error) = self
            .terminal_events
            .lock()
            .expect("terminal event journal lock")
            .retain(&backend_event)
        {
            crate::logging::write_executor_error_line(&error);
        }
        let _ = self.event_tx.send(event);
        let _ = self.backend_tx.send(backend_event);
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
        let next_sequence = epoch_millis.saturating_mul(1000).max(1);
        Self {
            events: VecDeque::new(),
            bytes: 0,
            // A new process cannot replay events from an earlier journal.
            dropped_through: next_sequence.saturating_sub(1),
            next_sequence,
        }
    }

    fn append(&mut self, raw: Value) -> (Value, Value) {
        let sequence = self.take_sequence();
        let envelope = event_envelope(raw, sequence);
        // Construct metadata once for every consumer, retaining the full
        // terminal payload before applying the UI history budget.
        let terminal = is_terminal(&envelope).then(|| envelope.clone());
        let event = bounded_event_envelope(envelope);
        let backend_event = terminal.unwrap_or_else(|| event.clone());
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
        (event, backend_event)
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

fn merge_coalesced_event(pending: &mut Value, next: &Value) -> bool {
    if pending.get("event").and_then(Value::as_str) == Some("response.block.updated") {
        return merge_block_updates(pending, next);
    }
    *pending = next.clone();
    true
}

fn merge_block_updates(pending: &mut Value, next: &Value) -> bool {
    if pending.pointer("/payload/data/block").is_some()
        || next.pointer("/payload/data/block").is_some()
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
    for (delta, snapshot) in [
        ("content_delta", "content"),
        ("tool_output_delta", "tool_output"),
    ] {
        if (current_updates.contains_key(delta) && next_updates.contains_key(snapshot))
            || (current_updates.contains_key(snapshot) && next_updates.contains_key(delta))
            || [current_updates, next_updates]
                .iter()
                .any(|updates| updates.get(delta).is_some_and(|value| !value.is_string()))
        {
            return false;
        }
    }
    if next_updates.iter().any(|(key, next_value)| {
        current_updates.get(key).is_some_and(|current_value| {
            (current_value.is_object() || next_value.is_object()) && current_value != next_value
        })
    }) {
        return false;
    }
    for (key, value) in next_updates {
        let value = match (
            key.as_str(),
            current_updates.get(key).and_then(Value::as_str),
        ) {
            ("content_delta" | "tool_output_delta", Some(current)) => {
                Value::String(format!("{current}{}", value.as_str().unwrap()))
            }
            _ => value.clone(),
        };
        current_updates.insert(key.clone(), value);
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

fn bounded_event_envelope(mut event: Value) -> Value {
    let sequence = event_sequence(&event).expect("event sequence");
    let original_event = event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("executor.unknown")
        .chars()
        .take(EVENT_METADATA_MAX_CHARS)
        .collect::<String>();
    let task_id = event_task_id(&event).map(|task_id| {
        task_id
            .chars()
            .take(EVENT_METADATA_MAX_CHARS)
            .collect::<String>()
    });
    let bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());
    if bytes <= EVENT_ENVELOPE_MAX_BYTES {
        return event;
    }
    event["event"] = json!("executor.event_lagged");
    event["payload"] = json!({
        "reason": "event_too_large",
        "originalEvent": original_event,
        "originalBytes": bytes,
        "taskId": task_id,
        "latestSequence": sequence,
    });
    event
}

#[cfg(test)]
mod tests;
