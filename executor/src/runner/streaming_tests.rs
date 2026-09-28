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
