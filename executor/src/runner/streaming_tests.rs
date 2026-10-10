// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, time::Duration};

use serde_json::json;
use tokio::sync::{mpsc, Notify, Semaphore};

use super::*;
use crate::emitter::ResponsesEventBuilder;

#[derive(Clone)]
struct BudgetedSink {
    started: Arc<Notify>,
    permits: Arc<Semaphore>,
    events: mpsc::UnboundedSender<EventEnvelope>,
}

impl EventSink for BudgetedSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let sink = self.clone();
        Box::pin(async move {
            sink.started.notify_one();
            sink.permits.acquire().await.unwrap().forget();
            sink.events.send(event).map_err(|error| error.to_string())
        })
    }
}

fn recording_sink() -> (BudgetedSink, mpsc::UnboundedReceiver<EventEnvelope>) {
    let (events, receiver) = mpsc::unbounded_channel();
    (
        BudgetedSink {
            started: Arc::new(Notify::new()),
            permits: Arc::new(Semaphore::new(1000)),
            events,
        },
        receiver,
    )
}

async fn receive(receiver: &mut mpsc::UnboundedReceiver<EventEnvelope>) -> EventEnvelope {
    tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("callback must not wait for completion or the long test batch window")
        .unwrap()
}

#[test]
fn batching_does_not_cross_identity_or_offset_boundaries() {
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let mut first = builder.response_text_delta_for_item("body", "ab", 0);
    first.data["block_offset"] = json!(0);
    let mut next = builder.response_text_delta_for_item("body", "cd", 2);
    next.data["block_offset"] = json!(2);
    for (field, value) in [
        ("item_id", json!("other")),
        ("offset", json!(3)),
        ("block_offset", json!(0)),
        ("content_index", json!(1)),
        ("output_index", json!(1)),
    ] {
        let mut compacted = None;
        compact_stream_event(&mut compacted, Box::new(first.clone())).unwrap();
        let mut incompatible = next.clone();
        incompatible.data[field] = value;
        assert!(compact_stream_event(&mut compacted, Box::new(incompatible)).is_err());
        assert_eq!(compacted.unwrap().text.as_deref(), Some("ab"));
    }
}

#[tokio::test]
async fn timed_batch_sends_first_delta_immediately_and_tail_without_new_input() {
    let (sink, mut receiver) = recording_sink();
    let dispatcher = StreamingEventDispatcher::new(sink);
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let text = |offset| {
        let mut event = builder.response_text_delta_for_item("body", "\u{4f60}\u{1f600}", offset);
        event.data["block_offset"] = json!(offset);
        event
    };
    EventSink::send(&dispatcher, text(0)).await.unwrap();
    assert_eq!(receive(&mut receiver).await.data["offset"], 0);
    for index in 1..=20 {
        EventSink::send(&dispatcher, text(index * 2)).await.unwrap();
    }
    let tail = receive(&mut receiver).await;
    assert_eq!(tail.data["delta"], "\u{4f60}\u{1f600}".repeat(20));
    assert_eq!(tail.data["offset"], 2);
    assert_eq!(tail.data["block_offset"], 2);
    assert!(receiver.try_recv().is_err());
    dispatcher.abort();
}

#[tokio::test]
async fn batch_flushes_thinking_and_body_before_tools_without_waiting_for_timer() {
    let (sink, mut receiver) = recording_sink();
    let dispatcher =
        StreamingEventDispatcher::with_compaction(sink, false, Some(Duration::from_secs(60)));
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    for delta in ["first", " second", " third"] {
        dispatcher.send_text_delta(
            builder.response_reasoning_delta(delta),
            "test",
            vec![],
            delta.len(),
        );
    }
    assert_eq!(receive(&mut receiver).await.data["delta"], "first");
    EventSink::send(
        &dispatcher,
        builder.response_text_delta_for_item("body", "a", 0),
    )
    .await
    .unwrap();
    assert_eq!(receive(&mut receiver).await.data["delta"], " second third");
    assert_eq!(receive(&mut receiver).await.data["delta"], "a");
    for offset in 1..=3 {
        EventSink::send(
            &dispatcher,
            builder.response_text_delta_for_item("body", "b", offset),
        )
        .await
        .unwrap();
    }
    dispatcher.send(
        builder.envelope(
            "response.function_call_arguments.done",
            json!({"item_id":"tool"}),
        ),
        "test",
        vec![],
    );
    assert_eq!(receive(&mut receiver).await.data["delta"], "bbb");
    assert_eq!(
        receive(&mut receiver).await.event_type,
        "response.function_call_arguments.done"
    );
    dispatcher.abort();
}

#[tokio::test]
async fn completion_compacts_entire_backlog_and_keeps_full_result_without_timer_delay() {
    let (mut sink, mut receiver) = recording_sink();
    sink.permits = Arc::new(Semaphore::new(0));
    let dispatcher = StreamingEventDispatcher::with_compaction(
        sink.clone(),
        false,
        Some(Duration::from_secs(60)),
    );
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    EventSink::send(
        &dispatcher,
        builder.response_text_delta_for_item("body", "x", 0),
    )
    .await
    .unwrap();
    sink.started.notified().await;
    for offset in 1..=1000 {
        EventSink::send(
            &dispatcher,
            builder.response_text_delta_for_item("body", "x", offset),
        )
        .await
        .unwrap();
    }
    let permits = sink.permits.clone();
    let compact_pending = dispatcher.compact_pending.clone();
    let finish = tokio::spawn(async move {
        dispatcher.compact_pending_and_flush("1", "2").await;
        dispatcher.result().unwrap();
        sink.send(builder.response_completed(&"x".repeat(1001)))
            .await
            .unwrap();
        dispatcher.abort();
    });
    // Exactly three sends are allowed: the in-flight first chunk, one combined
    // backlog, and the full completion. Per-chunk draining would deadlock.
    tokio::time::timeout(Duration::from_secs(2), async {
        while !compact_pending.load(Ordering::Relaxed) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    permits.add_permits(3);
    assert_eq!(receive(&mut receiver).await.data["delta"], "x");
    let tail = receive(&mut receiver).await;
    assert_eq!(tail.data["delta"], "x".repeat(1000));
    assert_eq!(tail.data["offset"], 1);
    let completed = receive(&mut receiver).await;
    assert_eq!(completed.event_type, "response.completed");
    assert_eq!(
        completed.data["response"]["output"][0]["content"][0]["text"],
        "x".repeat(1001)
    );
    finish.await.unwrap();
}

#[tokio::test]
async fn live_backlog_delivers_latest_snapshots_and_body_before_turn_completion() {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let sink = BudgetedSink {
        started: Arc::new(Notify::new()),
        permits: Arc::new(Semaphore::new(0)),
        events: sender,
    };
    let dispatcher = StreamingEventDispatcher::with_live_compaction(sink.clone());
    let builder = ResponsesEventBuilder::new("514", "796", "test").with_message_id(Some(10));
    let send = |kind: &str, data: Value| EventSink::send(&dispatcher, builder.envelope(kind, data));
    send(
        "response.block.created",
        json!({"block": {"id": "thinking", "type": "thinking", "content": ""}}),
    )
    .await
    .unwrap();
    sink.started.notified().await;

    // The first callback stays blocked while a complete burst enters the queue.
    for (id, kind, field, piece) in [
        ("thinking", "thinking", "content", "分析🙂"),
        ("commentary", "text", "content", "进度"),
        ("tool", "tool", "tool_output", "输出"),
    ] {
        if id != "thinking" {
            send(
                "response.block.created",
                json!({"block": {"id": id, "type": kind, "status": "streaming"}}),
            )
            .await
            .unwrap();
        }
        for count in 1..=400 {
            send(
                "response.block.updated",
                json!({"block_id": id, "updates": {field: piece.repeat(count)}}),
            )
            .await
            .unwrap();
        }
        send(
            "response.block.updated",
            json!({"block_id": id, "updates": {"status": "done"}}),
        )
        .await
        .unwrap();
    }
    for count in 0..400 {
        send(
            "response.output_text.delta",
            json!({"item_id": "final", "offset": count * 3, "delta": "正文🙂"}),
        )
        .await
        .unwrap();
    }

    // A slow receiver permits only 20 callbacks. No flush or turn completion is
    // sent: queued progress, including the final tail, must catch up on its own.
    sink.permits.add_permits(20);
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let mut blocks = Vec::<Value>::new();
        let mut text = String::new();
        while let Some(event) = receiver.recv().await {
            assert_eq!(event.task_id, "514");
            assert_eq!(event.subtask_id, "796");
            assert_eq!(event.message_id, Some(10));
            match event.event_type.as_str() {
                "response.block.created" => blocks.push(event.data["block"].clone()),
                "response.block.updated" => {
                    let block = blocks
                        .iter_mut()
                        .find(|block| block["id"] == event.data["block_id"])
                        .expect("creation must precede every block update");
                    block
                        .as_object_mut()
                        .unwrap()
                        .extend(event.data["updates"].as_object().unwrap().clone());
                }
                "response.output_text.delta" => {
                    assert_eq!(event.data["offset"], text.chars().count());
                    text.push_str(event.data["delta"].as_str().unwrap());
                    if text == "正文🙂".repeat(400) {
                        return blocks;
                    }
                }
                other => panic!("unexpected callback: {other}"),
            }
        }
        panic!("callback stream closed before the current content arrived");
    })
    .await;
    dispatcher.abort();
    let blocks = result.expect("live progress must not wait for turn completion or 1600 callbacks");
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["content"], "分析🙂".repeat(400));
    assert_eq!(blocks[1]["content"], "进度".repeat(400));
    assert_eq!(blocks[2]["tool_output"], "输出".repeat(400));
    assert!(blocks.iter().all(|block| block["status"] == "done"));
}
