// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{
    bounded_event_envelope, coalescing_key, event_sequence, merge_coalesced_event, EventJournal,
    ExecutorEventHub, EVENT_ENVELOPE_MAX_BYTES, EVENT_JOURNAL_MAX_EVENTS,
};
use serde_json::json;
use tokio::sync::broadcast;

mod accounts;

fn scoped(mut event: serde_json::Value, account: &str) -> serde_json::Value {
    event[super::RAW_ACCOUNT] = json!(account);
    event
}

fn event_hub() -> ExecutorEventHub {
    let (raw_tx, _) = broadcast::channel(8);
    ExecutorEventHub::new(raw_tx)
}

#[tokio::test(start_paused = true)]
async fn streaming_events_cannot_report_journal_recovery() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("journal");
    std::fs::write(&directory, b"blocked").unwrap();
    let (raw, _) = broadcast::channel(8);
    let hub = ExecutorEventHub::new(raw.clone());
    hub.enable_terminal_event_journal(directory);
    let mut live = hub.subscribe_live();
    hub.ensure_started();
    raw.send(scoped(
        json!({"event":"response.completed","payload":{"taskId":"task-a"}}),
        "account-a",
    ))
    .unwrap();
    assert_eq!(live.recv().await.unwrap()["event"], "response.completed");
    assert_eq!(
        live.recv().await.unwrap()["payload"]["reason"],
        "terminal_journal_unavailable"
    );
    raw.send(scoped(
        json!({"event":"response.output_text.delta","payload":{"taskId":"task-b","data":{"value":"stream"}}}),
        "account-a",
    ))
    .unwrap();
    assert_eq!(
        live.recv().await.unwrap()["event"],
        "response.output_text.delta"
    );
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(matches!(
        live.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn terminal_storage_recovers_without_a_backend_connection() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("journal");
    std::fs::write(&directory, b"blocked").unwrap();
    let (raw, _) = broadcast::channel(8);
    let hub = ExecutorEventHub::new(raw.clone());
    hub.enable_terminal_event_journal(directory.clone());
    let mut live = hub.subscribe_live();
    hub.ensure_started();
    raw.send(scoped(
        json!({"event":"response.completed","payload":{"taskId":"task-a"}}),
        "account-a",
    ))
    .unwrap();
    let terminal = live.recv().await.unwrap();
    assert_eq!(terminal["event"], "response.completed");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if live.recv().await.unwrap()["payload"]["reason"] == "terminal_journal_unavailable" {
                break;
            }
        }
    })
    .await
    .unwrap();
    std::fs::remove_file(&directory).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if live.recv().await.unwrap()["payload"]["reason"] == "terminal_journal_recovered" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let (sender, _) = broadcast::channel(8);
    let reopened = ExecutorEventHub::new(sender);
    reopened.enable_terminal_event_journal(directory);
    assert_eq!(
        reopened.pending_backend_terminals("account-a").unwrap(),
        vec![terminal]
    );
}

#[test]
fn oversized_completions_remain_deliverable_without_expanding_ui_history() {
    let hub = event_hub();
    let mut backend = hub.subscribe_backend("account-a", 0);
    let content = "x".repeat(EVENT_ENVELOPE_MAX_BYTES + 1);
    hub.publish(scoped(json!({"event":"response.completed","payload":{"taskId":"a","data":{"turnId":"turn-a","value":content}}}), "account-a"));
    let live = backend.receiver.try_recv().unwrap().value;
    assert_eq!(live["event"], "response.completed");
    assert_eq!(live["payload"]["data"]["value"], content);
    assert_eq!(
        hub.subscribe_after(0).replay[0]["event"],
        "executor.event_lagged"
    );
    let replay = hub.pending_backend_terminals("account-a").unwrap();
    assert!(replay.contains(&live));
    assert!(hub.subscribe_backend("account-a", 0).replay.is_empty());
    hub.acknowledge_backend("account-a", &live).unwrap();
    assert!(hub
        .pending_backend_terminals("account-a")
        .unwrap()
        .iter()
        .all(|event| event["event"] != "response.completed"));
}

#[test]
fn backend_replay_preserves_lag_markers_only_for_nonterminal_sources() {
    for (event, expected) in [("response.completed", 0), ("response.output_text.delta", 1)] {
        let hub = event_hub();
        hub.publish(scoped(
            json!({"event":event,"payload":{"taskId":"task-a","data":{"value":"x".repeat(EVENT_ENVELOPE_MAX_BYTES + 1)}}}),
            "account-a",
        ));
        let replay = hub.subscribe_backend("account-a", 0).replay;
        assert_eq!(replay.len(), expected, "{event}");
        if expected > 0 {
            assert_eq!(replay[0]["event"], "executor.event_lagged");
        }
    }
}

#[test]
fn backend_completions_survive_history_overflow_and_runner_replacement() {
    let hub = event_hub();
    hub.publish(scoped(
        json!({"event":"response.completed","payload":{"taskId":"task-1","subtaskId":"turn-1"}}),
        "account-a",
    ));
    let terminal = hub
        .pending_backend_terminals("account-a")
        .unwrap()
        .remove(0);
    let sequence = event_sequence(&terminal).unwrap();
    for _ in 0..EVENT_JOURNAL_MAX_EVENTS + 1 {
        hub.publish(json!({"event":"response.output_text.delta","payload":{"delta":"x"}}));
    }
    assert!(hub
        .subscribe_after(sequence)
        .replay
        .iter()
        .all(|event| event["event"] != "response.completed"));
    let replay = hub.pending_backend_terminals("account-a").unwrap();
    assert!(replay.contains(&terminal));
    hub.acknowledge_backend("account-a", &terminal).unwrap();
    assert!(hub
        .pending_backend_terminals("account-a")
        .unwrap()
        .iter()
        .all(|event| event["event"] != "response.completed"));
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
    let (first, _) = journal.append(json!({"event": "response.created", "payload": {}}));
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
    let (event, _) = journal.append(json!({
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
    let (event, _) = journal.append(json!({
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
fn bounding_an_event_preserves_its_original_sequence_and_timestamp() {
    for content in ["small".to_owned(), "x".repeat(EVENT_ENVELOPE_MAX_BYTES)] {
        let envelope = json!({
            "type":"event","protocolVersion":1,"sequence":41,
            "emittedAt":"2000-01-01T00:00:00.001Z",
            "event":"response.completed","payload":{"taskId":"a","data":{"value":content}}
        });
        let bounded = bounded_event_envelope(envelope.clone());
        for field in ["type", "protocolVersion", "sequence", "emittedAt"] {
            assert_eq!(bounded[field], envelope[field], "{field}");
        }
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= EVENT_ENVELOPE_MAX_BYTES);
    }
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
