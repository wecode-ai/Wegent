// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;

use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::emitter::EventEnvelope;

#[derive(Clone)]
struct RecordingSink(mpsc::UnboundedSender<EventEnvelope>);

impl EventSink for RecordingSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        std::future::ready(self.0.send(event).map_err(|error| error.to_string()))
    }
}

fn partial(event: Value) -> Value {
    json!({"type":"stream_event", "event":event})
}

async fn send_line(writer: &mut tokio::io::DuplexStream, event: Value) {
    writer
        .write_all(format!("{event}\n").as_bytes())
        .await
        .unwrap();
}

async fn next_event(receiver: &mut mpsc::UnboundedReceiver<EventEnvelope>) -> EventEnvelope {
    timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn native_partial_text_and_thinking_are_emitted_before_snapshots_and_eof() {
    let (mut writer, reader) = tokio::io::duplex(8192);
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let read = tokio::spawn(read_streaming_stdout(
        reader,
        RecordingSink(sender),
        ResponsesEventBuilder::new("1", "2", "test"),
        "1".into(),
        "2".into(),
        None,
    ));
    send_line(
        &mut writer,
        json!({"type":"stream_event", "session_id":"native-session", "event":{
            "type":"message_start", "message":{"id":"m1"}
        }}),
    )
    .await;
    send_line(&mut writer, partial(json!({"type":"content_block_start", "index":0, "content_block":{"type":"thinking","thinking":""}}))).await;
    send_line(&mut writer, partial(json!({"type":"content_block_delta", "index":0, "delta":{"type":"thinking_delta","thinking":"plan"}}))).await;
    let thinking = next_event(&mut receiver).await;
    assert_eq!(thinking.event_type, "response.reasoning_summary_text.delta");
    assert_eq!(thinking.data["delta"], "plan");
    send_line(&mut writer, json!({"type":"assistant", "message":{"id":"m1", "content":[{"type":"thinking", "thinking":"plan"}]}})).await;
    send_line(
        &mut writer,
        partial(json!({"type":"content_block_stop", "index":0})),
    )
    .await;
    send_line(&mut writer, partial(json!({"type":"content_block_start", "index":1, "content_block":{"type":"text","text":""}}))).await;
    let first = "\u{4f60}\u{597d}\u{1f600}";
    send_line(&mut writer, partial(json!({"type":"content_block_delta", "index":1, "delta":{"type":"text_delta","text":first}}))).await;
    let text = next_event(&mut receiver).await;
    assert_eq!(text.event_type, "response.output_text.delta");
    assert_eq!(text.data["delta"], first);
    assert_eq!(text.data["offset"], 0);
    assert!(!read.is_finished());
    send_line(&mut writer, partial(json!({"type":"content_block_delta", "index":1, "delta":{"type":"text_delta","text":" tail"}}))).await;
    let tail = next_event(&mut receiver).await;
    assert_eq!(tail.data["delta"], " tail");
    assert_eq!(tail.data["offset"], 3);
    assert_eq!(tail.data["block_offset"], 3);
    send_line(&mut writer, json!({"type":"assistant", "message":{"id":"m1", "content":[{"type":"text", "text":format!("{first} tail")}]}})).await;
    send_line(
        &mut writer,
        partial(json!({"type":"content_block_stop", "index":1})),
    )
    .await;
    send_line(&mut writer, partial(json!({"type":"message_stop"}))).await;
    send_line(
        &mut writer,
        json!({"type":"result", "subtype":"success", "is_error":false}),
    )
    .await;
    drop(writer);
    let StreamingStdoutOutcome::Success(stdout) = read.await.unwrap() else {
        panic!("invalid stream")
    };
    assert!(
        receiver.try_recv().is_err(),
        "snapshots must not emit duplicates"
    );
    let summary = collect_claude_stream_summary(&stdout);
    assert_eq!(summary.session_id.as_deref(), Some("native-session"));
    assert_eq!(
        summary.outcome,
        ExecutionOutcome::Completed {
            content: format!("{first} tail")
        }
    );
}

#[tokio::test]
async fn native_partials_preserve_tool_child_and_message_boundaries() {
    for omit_root_ids in [false, true] {
        assert_native_partial_boundaries(omit_root_ids).await;
    }
}

async fn assert_native_partial_boundaries(omit_root_ids: bool) {
    let mut events = [
        partial(json!({"type":"message_start", "message":{"id":"m1"}})),
        partial(
            json!({"type":"content_block_start", "index":0, "content_block":{"type":"text","text":""}}),
        ),
        partial(
            json!({"type":"content_block_delta", "index":0, "delta":{"type":"text_delta","text":"before"}}),
        ),
        json!({"type":"assistant", "message":{"id":"m1", "content":[{"type":"text","text":"before"}]}}),
        partial(json!({"type":"content_block_stop", "index":0})),
        partial(
            json!({"type":"content_block_start", "index":1, "content_block":{"type":"tool_use","id":"tool1","name":"Bash"}}),
        ),
        partial(
            json!({"type":"content_block_delta", "index":1, "delta":{"type":"input_json_delta","partial_json":"secret"}}),
        ),
        json!({"type":"assistant", "message":{"id":"m1", "content":[{"type":"tool_use","id":"tool1","name":"Bash","input":{"command":"true"}}]}}),
        partial(json!({"type":"content_block_stop", "index":1})),
        partial(json!({"type":"message_stop"})),
        json!({"type":"assistant", "parent_tool_use_id":"agent1", "message":{"id":"child1", "content":[{"type":"text","text":"child"}]}}),
        json!({"type":"user", "message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"ok"}]}}),
        partial(json!({"type":"message_start", "message":{"id":"m2"}})),
        partial(
            json!({"type":"content_block_start", "index":0, "content_block":{"type":"text","text":""}}),
        ),
        partial(
            json!({"type":"content_block_delta", "index":0, "delta":{"type":"text_delta","text":"after"}}),
        ),
        json!({"type":"assistant", "message":{"id":"m2", "content":[{"type":"text","text":"after"}]}}),
        partial(json!({"type":"content_block_stop", "index":0})),
        partial(json!({"type":"message_stop"})),
        json!({"type":"result", "subtype":"success", "is_error":false}),
    ];
    if omit_root_ids {
        for event in &mut events {
            if !event["parent_tool_use_id"].is_null() {
                continue;
            }
            let message = if event["type"] == "stream_event" {
                event["event"].get_mut("message")
            } else {
                event.get_mut("message")
            };
            if let Some(message) = message.and_then(Value::as_object_mut) {
                message.remove("id");
            }
        }
    }
    let stdout = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let outcome = read_streaming_stdout(
        stdout.as_bytes(),
        RecordingSink(sender),
        ResponsesEventBuilder::new("1", "2", "test"),
        "1".into(),
        "2".into(),
        None,
    )
    .await;
    assert!(matches!(outcome, StreamingStdoutOutcome::Success(_)));
    let mut order = Vec::new();
    let mut items = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        match event.event_type.as_str() {
            "response.output_text.delta" => {
                order.push(event.data["delta"].as_str().unwrap().to_owned());
                items.push(event.data["item_id"].clone());
                assert_eq!(event.data["block_offset"], 0);
                assert_eq!(event.data["offset"], if items.len() == 1 { 0 } else { 6 });
            }
            "response.block.created" => {
                order.push(event.data["block"]["id"].as_str().unwrap().to_owned())
            }
            "response.block.updated" => order.push("tool done".into()),
            _ => {}
        }
    }
    assert_eq!(
        order,
        ["before", "tool1", "child1:text:0", "tool done", "after"]
    );
    assert_ne!(items[0], items[1]);
    assert_eq!(
        collect_claude_stream_summary(&stdout).outcome,
        ExecutionOutcome::Completed {
            content: "after".into()
        }
    );
}

#[tokio::test]
async fn claude_segments_keep_turn_offsets_and_native_item_offsets() {
    let introduction = "Starting three jobs.\n";
    let progress = "Job one finished.\n";
    let summary = format!("| Job | Result |\n{}", "| job | success |\n".repeat(40));
    let messages = [
        json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": introduction}
        ]}}),
        json!({"type": "assistant", "message": {"id": "tools", "content": [
            {"type": "text", "text": "Before tool"},
            {"type": "tool_use", "id": "tool-1", "name": "Bash", "input": {"command": "true"}},
            {"type": "text", "text": "After tool"}
        ]}}),
        json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tool-1", "content": "ok"}
        ]}}),
        json!({"type": "assistant", "message": {"id": "progress", "content": [
            {"type": "thinking", "thinking": "Synthetic reasoning"},
            {"type": "text", "text": progress}
        ]}}),
        json!({"type": "user", "message": {"content": "Synthetic notification"}}),
        json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": summary}
        ]}}),
    ];
    let stdout = messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let outcome = read_streaming_stdout(
        stdout.as_bytes(),
        RecordingSink(sender),
        ResponsesEventBuilder::new("1", "2", "test"),
        "1".into(),
        "2".into(),
        None,
    )
    .await;
    assert!(matches!(outcome, StreamingStdoutOutcome::Success(_)));

    let mut text = String::new();
    let mut items = HashMap::<String, String>::new();
    let mut ordered_blocks = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        if event.event_type == "response.output_text.delta" {
            assert_eq!(event.data["offset"], text.chars().count());
            let item = items
                .entry(event.data["item_id"].as_str().unwrap().into())
                .or_default();
            assert_eq!(event.data["block_offset"], item.chars().count());
            let delta = event.data["delta"].as_str().unwrap();
            text.push_str(delta);
            item.push_str(delta);
        } else if event.event_type == "response.block.created" {
            ordered_blocks.push(event.data["block"]["id"].as_str().unwrap().to_owned());
        } else if event.event_type == "response.output_item.added" {
            ordered_blocks.push(event.data["item"]["id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(text, format!("{introduction}{progress}{summary}"));
    assert_eq!(items.len(), 3);
    assert_eq!(
        &ordered_blocks[..3],
        ["tools:text:0", "tool-1", "tools:text:2"]
    );
}
