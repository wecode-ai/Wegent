// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused compatibility tests for the execution callback.
use super::emitter::chunk_payload_for_test;
use super::event::ExecutionEvent;
use super::parser;
use super::py_json::python_dumps;
use super::{channel, session};
use serde_json::json;

#[test]
fn lifecycle_events_are_skipped() {
    let event = parser::shared()
        .parse(1, 2, None, "response.in_progress", &json!({}))
        .expect("parse");
    assert!(event.is_none());
}

#[test]
fn response_created_maps_to_start_with_shell_type() {
    let data = json!({"shell_type": "claudecode", "type": "response.created"});
    let event = parser::shared()
        .parse(
            801406538445813,
            801406538445816,
            Some(2),
            "response.created",
            &data,
        )
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "start");
    assert_eq!(event.data.get("shell_type"), Some(&json!("claudecode")));
    assert!(!event.data.contains_key("type"));
}

#[test]
fn block_created_requires_object_block() {
    let missing = parser::shared()
        .parse(1, 2, None, "response.block.created", &json!({"block": "x"}))
        .expect("parse");
    assert!(missing.is_none());

    let block = json!({"id": "b1", "type": "tool"});
    let event = parser::shared()
        .parse(
            1,
            2,
            None,
            "response.block.created",
            &json!({"block": block}),
        )
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "block_created");
    assert_eq!(event.data.get("block"), Some(&block));
}

#[test]
fn block_updated_coerces_block_id_to_string() {
    let data = json!({"block_id": 123, "updates": {"status": "done"}});
    let event = parser::shared()
        .parse(1, 2, None, "response.block.updated", &data)
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "block_updated");
    assert_eq!(event.data.get("block_id"), Some(&json!("123")));
}

#[test]
fn output_text_delta_maps_to_chunk() {
    let data = json!({"delta": "hello", "offset": 5});
    let event = parser::shared()
        .parse(1, 2, None, "response.output_text.delta", &data)
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "chunk");
    assert_eq!(event.content, "hello");
    assert_eq!(event.offset, 5);
}

#[test]
fn start_callback_channel_payload_matches_recorded_bytes() {
    let data = json!({"shell_type": "claudecode"});
    let mut event = ExecutionEvent::new(
        super::event::EventType::Start,
        801406538445813,
        801406538445816,
    );
    event.data = data.as_object().cloned().unwrap_or_default();
    event.message_id = Some(2);
    assert_eq!(
        python_dumps(&event.to_value()),
        "{\"type\": \"start\", \"task_id\": 801406538445813, \"subtask_id\": 801406538445816, \
         \"content\": \"\", \"offset\": 0, \"result\": null, \"progress\": 0, \"status\": \"\", \
         \"error\": null, \"error_code\": null, \"tool_name\": null, \"tool_use_id\": null, \
         \"tool_input\": null, \"tool_output\": null, \"message_id\": 2, \"executor_name\": null, \
         \"executor_namespace\": null, \"timestamp\": null, \"data\": {\"shell_type\": \"claudecode\"}}"
    );
}

#[test]
fn chat_chunk_payload_keeps_source_key_order() {
    let mut event = ExecutionEvent::new(super::event::EventType::Chunk, 10, 20);
    let payload = chunk_payload_for_test(&event, "hi", 3, Some(2), None, None, None);
    assert_eq!(
        python_dumps(&payload),
        "{\"subtask_id\": 20, \"content\": \"hi\", \"offset\": 3, \"task_id\": 10, \"message_id\": 2}"
    );
    // Result is only included when present.
    event.message_id = None;
    let payload = chunk_payload_for_test(
        &event,
        "",
        0,
        None,
        None,
        None,
        Some(json!({"reasoning_chunk": "r"})),
    );
    assert_eq!(
        python_dumps(&payload),
        "{\"subtask_id\": 20, \"content\": \"\", \"offset\": 0, \"task_id\": 10, \
         \"result\": {\"reasoning_chunk\": \"r\"}}"
    );
}

#[test]
fn streaming_key_layout_matches_source() {
    assert_eq!(session::streaming_key(5), "chat:streaming:5");
    assert_eq!(session::blocks_key(5), "chat:streaming:blocks:5");
    assert_eq!(session::callback_channel(5), "callback:channel:5");
}

#[test]
fn channel_prefixes_are_dingtalk_then_telegram() {
    assert_eq!(
        channel::channel_key_prefixes(),
        [
            "channel:task_callback:dingtalk:",
            "channel:task_callback:telegram:"
        ]
    );
}
