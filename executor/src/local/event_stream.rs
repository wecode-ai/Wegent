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
use tokio::sync::broadcast;

use super::RUNTIME_EVENT_BUFFER_CAPACITY;

const EVENT_JOURNAL_MAX_EVENTS: usize = 4096;
const EVENT_JOURNAL_MAX_BYTES: usize = 8 * 1024 * 1024;

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

    pub fn ensure_started(&self) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let mut receiver = self.raw_tx.subscribe();
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => hub.publish(event),
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        hub.publish(json!({
                            "type": "event",
                            "event": "executor.event_lagged",
                            "payload": {
                                "skipped": skipped,
                                "reason": "executor_event_ingress_backpressure",
                            },
                        }));
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    pub fn subscribe_live(&self) -> broadcast::Receiver<Value> {
        self.event_tx.subscribe()
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
        let event = event_envelope(raw, sequence);
        let bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());
        if bytes > EVENT_JOURNAL_MAX_BYTES {
            self.dropped_through = sequence;
            self.events.clear();
            self.bytes = 0;
            return event;
        }

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

#[cfg(test)]
mod tests {
    use super::{event_sequence, EventJournal, EVENT_JOURNAL_MAX_BYTES, EVENT_JOURNAL_MAX_EVENTS};
    use serde_json::json;

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
    fn oversized_event_is_not_retained() {
        let mut journal = EventJournal::new();
        let event = journal.append(json!({
            "event": "response.block.updated",
            "payload": {"data": {"content": "x".repeat(EVENT_JOURNAL_MAX_BYTES)}},
        }));

        assert!(journal.events.is_empty());
        assert_eq!(journal.dropped_through, event_sequence(&event).unwrap());
    }
}
