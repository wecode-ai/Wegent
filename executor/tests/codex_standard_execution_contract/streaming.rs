// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, sync::Arc};

use tokio::sync::{Notify, Semaphore};
use wegent_executor::{runner::BackgroundTaskRunner, server::TaskRunner};

use super::*;

#[derive(Clone)]
struct GatedSink {
    started: Arc<Notify>,
    finished: Arc<Notify>,
    release: Arc<Semaphore>,
    events: Arc<Mutex<Vec<EventEnvelope>>>,
}

impl GatedSink {
    fn new() -> Self {
        Self {
            started: Arc::new(Notify::new()),
            finished: Arc::new(Notify::new()),
            release: Arc::new(Semaphore::new(0)),
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl EventSink for GatedSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let sink = self.clone();
        Box::pin(async move {
            if event.event_type == "response.created" {
                sink.events.lock().await.push(event);
                return Ok(());
            }
            sink.started.notify_one();
            let _permit = sink.release.acquire().await.unwrap();
            let completed = event.event_type == "response.completed";
            sink.events.lock().await.push(event);
            if completed {
                sink.finished.notify_one();
            }
            Ok(())
        })
    }
}

#[tokio::test]
async fn codex_slow_callback_does_not_block_protocol_and_compacts_remaining_body() {
    let _lock = env_lock().await;
    let text = "你好🙂".repeat(200);
    let mut notifications: Vec<_> = (0..200)
        .map(|_| {
            notification(
                "item/agentMessage/delta",
                json!({"itemId": "final", "phase": "finalAnswer", "delta": "你好🙂"}),
            )
        })
        .collect();
    notifications.push(notification(
        "item/completed",
        json!({"item": {
            "id": "final", "type": "agentMessage", "phase": "finalAnswer", "text": text
        }}),
    ));
    let fixture = Fixture::with_notifications(&notifications);
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    let sink = GatedSink::new();
    let request = fixture.request("slow-callback");
    let mut run =
        fixture
            .engine()
            .run_with_events(request.clone(), sink.clone(), builder(&request));

    tokio::time::timeout(TIMEOUT, async {
        tokio::select! {
            outcome = &mut run => panic!("completed before callback was released: {outcome:?}"),
            _ = sink.started.notified() => {}
        }
        let pid = fixture.messages()[0]["pid"].as_i64().unwrap() as i32;
        tokio::select! {
            outcome = &mut run => panic!("must flush callbacks before completing: {outcome:?}"),
            _ = wait_for_process_exit(pid) => {}
        }
        sink.release.add_permits(1);
        assert_eq!(
            run.await,
            ExecutionOutcome::Completed {
                content: text.clone()
            }
        );
    })
    .await
    .expect("a blocked callback must not hold the Codex protocol process open");

    let events = sink.events.lock().await;
    let chunks: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "response.output_text.delta")
        .collect();
    assert!(
        chunks.len() <= 2,
        "queued chunks were not compacted: {} callbacks",
        chunks.len()
    );
    let mut reconstructed = String::new();
    for event in chunks {
        assert_eq!(event.data["offset"], reconstructed.chars().count());
        assert_eq!(event.message_id, Some(71));
        reconstructed.push_str(event.data["delta"].as_str().unwrap());
    }
    assert_eq!(reconstructed, text);
}

#[tokio::test]
async fn codex_compacts_block_snapshots_and_delivers_content_before_final_callback() {
    let _lock = env_lock().await;
    let mut notifications = Vec::new();
    for (method, item_id, phase, delta) in [
        ("item/reasoning/summaryTextDelta", "reasoning", "", "分析🙂"),
        ("item/reasoning/textDelta", "raw-reasoning", "", "检查🙂"),
        (
            "item/agentMessage/delta",
            "commentary",
            "commentary",
            "检查",
        ),
    ] {
        for _ in 0..200 {
            notifications.push(notification(
                method,
                json!({"itemId": item_id, "phase": phase, "delta": delta}),
            ));
        }
    }
    notifications.push(notification("item/started", json!({"item": {
        "id": "command", "type": "commandExecution", "command": "printf version", "status": "inProgress"
    }})));
    for _ in 0..200 {
        notifications.push(notification(
            "item/commandExecution/outputDelta",
            json!({"itemId": "command", "delta": "输出"}),
        ));
    }
    notifications.push(notification("item/completed", json!({"item": {
        "id": "command", "type": "commandExecution", "command": "printf version", "status": "completed", "aggregatedOutput": "输出".repeat(200), "exitCode": 0
    }})));
    notifications.push(notification(
        "item/agentMessage/delta",
        json!({"itemId": "final", "phase": "finalAnswer", "delta": "done"}),
    ));
    let fixture = Fixture::with_notifications(&notifications);
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    let sink = GatedSink::new();
    let runner = BackgroundTaskRunner::new(fixture.engine(), sink.clone());
    runner.submit(fixture.request("slow-callback")).await;
    tokio::time::timeout(TIMEOUT, async {
        sink.started.notified().await;
        let pid = fixture.messages()[0]["pid"].as_i64().unwrap() as i32;
        wait_for_process_exit(pid).await;
        assert!(!sink
            .events
            .lock()
            .await
            .iter()
            .any(|event| event.event_type == "response.completed"));
        sink.release.add_permits(1);
        sink.finished.notified().await;
    })
    .await
    .expect("content must drain before the final task callback");

    let events = sink.events.lock().await;
    assert_eq!(events.first().unwrap().event_type, "response.created");
    assert_eq!(events.last().unwrap().event_type, "response.completed");
    assert!(
        events.len() < 20,
        "snapshot callbacks accumulated: {}",
        events.len()
    );
    let mut blocks = Vec::<Value>::new();
    for event in events.iter() {
        match event.event_type.as_str() {
            "response.block.created" => blocks.push(event.data["block"].clone()),
            "response.block.updated" => {
                let block = blocks
                    .iter_mut()
                    .find(|block| block["id"] == event.data["block_id"])
                    .expect("block creation must precede its updates");
                block
                    .as_object_mut()
                    .unwrap()
                    .extend(event.data["updates"].as_object().unwrap().clone());
            }
            _ => {}
        }
    }
    assert_eq!(
        blocks
            .iter()
            .map(|b| b["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["thinking", "thinking", "text", "tool"]
    );
    assert_eq!(blocks[0]["content"], "分析🙂".repeat(200));
    assert_eq!(blocks[1]["content"], "检查🙂".repeat(200));
    assert_eq!(blocks[2]["content"], "检查".repeat(200));
    assert_eq!(blocks[3]["tool_output"], "输出".repeat(200));
    assert_eq!(blocks[3]["status"], "done");
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "response.output_text.delta")
            .map(|e| e.data["delta"].as_str().unwrap())
            .collect::<String>(),
        "done"
    );
}
