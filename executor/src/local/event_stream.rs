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
        self.subscribe_after_internal(after, false)
    }

    pub fn subscribe_for_relay(&self, after: u64) -> ExecutorEventSubscription {
        self.subscribe_after_internal(after, true)
    }

    fn subscribe_after_internal(
        &self,
        after: u64,
        retain_history: bool,
    ) -> ExecutorEventSubscription {
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
            // Relay retained events before the higher-sequence recovery marker.
            // Snapshot consumers continue to receive only the recovery marker.
            let mut replay = if retain_history {
                state
                    .events
                    .iter()
                    .filter(|event| event.sequence > after)
                    .map(|event| event.value.clone())
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            replay.push(recovery);
            return ExecutorEventSubscription {
                replay,
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
        let next_sequence = epoch_millis.saturating_mul(1000).max(1);
        Self {
            events: VecDeque::new(),
            bytes: 0,
            // A new process cannot replay events from an earlier journal.
            dropped_through: next_sequence.saturating_sub(1),
            next_sequence,
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
        coalescing_key, event_sequence, merge_coalesced_event, EventJournal, ExecutorEventHub,
        EVENT_ENVELOPE_MAX_BYTES, EVENT_JOURNAL_MAX_EVENTS,
    };
    use serde_json::json;
    use tokio::sync::broadcast;

    fn event_hub() -> ExecutorEventHub {
        let (raw_tx, _) = broadcast::channel(8);
        ExecutorEventHub::new(raw_tx)
    }

    #[test]
    fn a_new_journal_reports_old_cursors_even_before_its_first_event() {
        for has_event in [false, true] {
            let hub = event_hub();
            let boundary = hub.subscribe_from_now().resume_after;
            let old_cursor = boundary.checked_sub(1).unwrap();
            assert!(old_cursor > 0);
            if has_event {
                hub.publish(json!({"event":"response.created","payload":{}}));
            }
            let latest = hub.subscribe_from_now().resume_after;

            let subscription = hub.subscribe_after(old_cursor);

            assert_eq!(subscription.replay.len(), 1);
            let recovery = &subscription.replay[0];
            assert_eq!(recovery["event"], "executor.event_lagged");
            assert_eq!(recovery["payload"]["reason"], "event_history_lost");
            assert_eq!(recovery["payload"]["requestedAfter"], old_cursor);
            assert_eq!(recovery["payload"]["latestSequence"], latest);
            assert!(subscription.resume_after > latest);
            assert!(hub
                .subscribe_after(subscription.resume_after)
                .replay
                .is_empty());
        }
    }

    #[test]
    fn zero_and_the_from_now_boundary_can_subscribe_without_false_history_loss() {
        let hub = event_hub();
        let from_now = hub.subscribe_from_now();
        assert!(hub.subscribe_after(0).replay.is_empty());
        assert!(hub.subscribe_after(from_now.resume_after).replay.is_empty());

        hub.publish(json!({"event":"response.created","payload":{}}));

        for cursor in [0, from_now.resume_after] {
            let resumed = hub.subscribe_after(cursor);
            assert_eq!(resumed.replay.len(), 1);
            assert_eq!(resumed.replay[0]["event"], "response.created");
            assert!(resumed.resume_after > from_now.resume_after);
            assert!(hub.subscribe_after(resumed.resume_after).replay.is_empty());
        }
    }

    #[test]
    fn retained_events_replay_only_after_the_same_journal_cursor() {
        let hub = event_hub();
        hub.publish(json!({"event":"response.created","payload":{}}));
        let first = hub.subscribe_from_now().resume_after;
        hub.publish(json!({"event":"response.completed","payload":{}}));

        let resumed = hub.subscribe_after(first);

        assert_eq!(resumed.replay.len(), 1);
        assert_eq!(resumed.replay[0]["event"], "response.completed");
        assert_eq!(resumed.resume_after, first + 1);
    }

    #[test]
    fn a_truncated_journal_preserves_its_exact_replay_boundary() {
        let hub = event_hub();
        let initial_boundary = hub.subscribe_from_now().resume_after;
        for _ in 0..=EVENT_JOURNAL_MAX_EVENTS {
            hub.publish(json!({"event":"response.created","payload":{}}));
        }
        let first_dropped = initial_boundary + 1;

        let retained = hub.subscribe_after(first_dropped);

        assert_eq!(retained.replay.len(), EVENT_JOURNAL_MAX_EVENTS);
        assert!(retained
            .replay
            .iter()
            .all(|event| event["event"] == "response.created"));
        assert_eq!(event_sequence(&retained.replay[0]), Some(first_dropped + 1));
        let lost = hub.subscribe_after(initial_boundary);
        assert_eq!(lost.replay.len(), 1);
        assert_eq!(lost.replay[0]["event"], "executor.event_lagged");
        assert_eq!(lost.replay[0]["payload"]["reason"], "event_history_lost");
    }

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

    #[tokio::test]
    async fn terminal_output_deltas_survive_coalescing_and_status_updates() {
        let (raw_tx, _) = broadcast::channel(8);
        let hub = ExecutorEventHub::new(raw_tx.clone());
        hub.ensure_started();
        let mut events = hub.subscribe_live();
        for updates in [
            json!({"tool_output_delta": "tick-5\n", "status": "streaming"}),
            json!({"tool_output_delta": "tick-6\n", "status": "streaming"}),
            json!({"tool_output_delta": "tick-7\n", "status": "streaming"}),
            json!({"status": "done"}),
        ] {
            raw_tx
                .send(json!({
                    "event": "response.block.updated",
                    "payload": {"taskId": "task-1", "subtaskId": "turn-1",
                        "data": {"block_id": "command-1", "updates": updates}}
                }))
                .unwrap();
        }
        raw_tx
            .send(json!({
                "event": "response.completed", "payload": {"taskId": "task-1"}
            }))
            .unwrap();

        let update = events.recv().await.unwrap();
        let terminal = events.recv().await.unwrap();

        assert_eq!(
            update["payload"]["data"]["updates"]["tool_output_delta"],
            "tick-5\ntick-6\ntick-7\n"
        );
        assert_eq!(update["payload"]["data"]["updates"]["status"], "done");
        assert_eq!(terminal["event"], "response.completed");
    }

    #[tokio::test]
    async fn output_snapshot_and_delta_boundaries_keep_their_original_order() {
        for (first, second) in [
            (
                json!({"tool_output_delta": "tick-6\n"}),
                json!({"tool_output": "snapshot\n"}),
            ),
            (
                json!({"tool_output": "snapshot\n"}),
                json!({"tool_output_delta": "tick-6\n"}),
            ),
            (
                json!({"content_delta": "live"}),
                json!({"content": "snapshot"}),
            ),
            (
                json!({"content": "snapshot"}),
                json!({"content_delta": "live"}),
            ),
            (
                json!({"render_payload": {"first": true}}),
                json!({"render_payload": {"second": true}}),
            ),
            (
                json!({"tool_output_delta": "live"}),
                json!({"tool_output_delta": null}),
            ),
        ] {
            let (raw_tx, _) = broadcast::channel(8);
            let hub = ExecutorEventHub::new(raw_tx.clone());
            hub.ensure_started();
            let mut events = hub.subscribe_live();
            for updates in [&first, &second] {
                raw_tx
                    .send(json!({
                        "event": "response.block.updated",
                        "payload": {"taskId": "task-1", "subtaskId": "turn-1",
                            "data": {"block_id": "command-1", "updates": updates}}
                    }))
                    .unwrap();
            }
            raw_tx
                .send(json!({
                    "event": "response.completed", "payload": {"taskId": "task-1"}
                }))
                .unwrap();

            let first_event = events.recv().await.unwrap();
            let second_event = events.recv().await.unwrap();

            assert_eq!(first_event["payload"]["data"]["updates"], first);
            assert_eq!(second_event["payload"]["data"]["updates"], second);
            assert!(event_sequence(&first_event).unwrap() < event_sequence(&second_event).unwrap());
        }
    }

    #[test]
    fn block_updates_preserve_metadata_before_a_delta() {
        let mut pending = json!({
            "event": "response.block.updated",
            "payload": {"data": {"updates": {"status": "streaming", "tool_name": "exec"}}}
        });
        let next = json!({
            "event": "response.block.updated",
            "payload": {"data": {"updates": {"tool_output_delta": "tick-6\n"}}}
        });

        assert!(merge_coalesced_event(&mut pending, &next));
        assert_eq!(
            pending["payload"]["data"]["updates"],
            json!({
                "status": "streaming", "tool_name": "exec", "tool_output_delta": "tick-6\n"
            })
        );
    }

    #[test]
    fn full_block_snapshots_are_not_collapsed_with_partial_updates() {
        let mut pending = json!({
            "event": "response.block.updated",
            "payload": {"data": {"updates": {"tool_output_delta": "tick-6\n"}}}
        });
        let original = pending.clone();
        let next = json!({
            "event": "response.block.updated",
            "payload": {"data": {"block": {"tool_output": "snapshot"}}}
        });

        assert!(!merge_coalesced_event(&mut pending, &next));
        assert_eq!(pending, original);
        let mut snapshot = next.clone();
        assert!(!merge_coalesced_event(&mut snapshot, &pending));
        assert_eq!(snapshot, next);
    }
}
