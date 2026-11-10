// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the `chat:block_created` / `chat:block_updated` frames.
use serde_json::{Map, Value, json};

use super::*;
use crate::internal_callback::event::EventType;
use crate::internal_callback::py_json::python_dumps;

fn keys(value: &Value) -> Vec<String> {
    value
        .as_object()
        .expect("object payload")
        .keys()
        .cloned()
        .collect()
}

fn tool_start_event() -> ExecutionEvent {
    let mut event = ExecutionEvent::new(
        EventType::ToolStart,
        893_490_636_671_579,
        893_490_636_671_584,
    );
    event.tool_use_id = Some("call_00_dsds8smxoghqk8uo3at3gz39".into());
    event.tool_name = Some("exec".into());
    event.tool_input = Some(json!({}));
    event
}

#[test]
fn tool_block_created_matches_the_recorded_shape() {
    // The recorded `chat:block_created` frame for a `function_call` tool: the
    // block carries no `tool_protocol`/`server_label`, only the persisted
    // block does.
    let mut event = tool_start_event();
    event.data.insert(
        "tool_protocol".into(),
        Value::String("function_call".into()),
    );
    event
        .data
        .insert("server_label".into(), Value::String("filesystem".into()));

    let payload = created_payload(event.task_id, event.subtask_id, &tool_block(&event));

    assert_eq!(keys(&payload), vec!["task_id", "subtask_id", "block"]);
    let block = payload["block"].as_object().expect("block object");
    assert_eq!(
        block.keys().cloned().collect::<Vec<_>>(),
        vec![
            "id",
            "type",
            "tool_use_id",
            "tool_name",
            "tool_input",
            "status",
            "timestamp"
        ]
    );
    assert_eq!(block["id"], json!("call_00_dsds8smxoghqk8uo3at3gz39"));
    assert_eq!(block["type"], json!("tool"));
    assert_eq!(
        block["tool_use_id"],
        json!("call_00_dsds8smxoghqk8uo3at3gz39")
    );
    assert_eq!(block["tool_name"], json!("exec"));
    assert_eq!(block["tool_input"], json!({}));
    assert_eq!(block["status"], json!("pending"));
    assert!(block["timestamp"].as_i64().is_some_and(|ts| ts > 0));
    assert!(python_dumps(&payload).starts_with(
        "{\"task_id\": 893490636671579, \"subtask_id\": 893490636671584, \"block\": {\"id\":"
    ));
}

#[test]
fn tool_block_created_streaming_arguments_appends_the_argument_status() {
    let mut event = tool_start_event();
    event
        .data
        .insert("argument_status".into(), Value::String("streaming".into()));

    let block = tool_block(&event);

    assert_eq!(block["status"], json!("generating_arguments"));
    assert_eq!(block["argument_status"], json!("streaming"));
    let order = block.keys().cloned().collect::<Vec<_>>();
    assert_eq!(order.last().map(String::as_str), Some("argument_status"));
}

#[test]
fn tool_block_created_keeps_a_display_name_and_omits_an_empty_one() {
    let mut event = tool_start_event();
    event
        .data
        .insert("display_name".into(), Value::String("Run".into()));
    let block = tool_block(&event);
    assert_eq!(block["display_name"], json!("Run"));
    assert_eq!(
        block.keys().cloned().collect::<Vec<_>>(),
        vec![
            "id",
            "type",
            "tool_use_id",
            "tool_name",
            "tool_input",
            "status",
            "timestamp",
            "display_name"
        ]
    );

    event
        .data
        .insert("display_name".into(), Value::String(String::new()));
    assert!(!tool_block(&event).contains_key("display_name"));
}

#[test]
fn tool_block_created_falls_back_to_an_empty_input_and_generated_id() {
    let mut event = ExecutionEvent::new(EventType::ToolStart, 1, 2);
    event.tool_use_id = Some(String::new());
    event.tool_name = Some("exec".into());

    let block = tool_block(&event);

    assert_eq!(block["tool_input"], json!({}));
    assert_eq!(block["tool_use_id"], json!(""));
    assert!(
        block["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("tool-"))
    );
}

#[test]
fn argument_frames_carry_input_then_status() {
    let mut event = tool_start_event();
    event.tool_input = Some(json!({"command": "ls"}));

    let delta = updated_payload(
        event.task_id,
        event.subtask_id,
        event.tool_use_id.as_deref().unwrap_or_default(),
        &argument_updates(&event, "generating_arguments"),
    );
    assert_eq!(
        keys(&delta),
        vec!["task_id", "subtask_id", "block_id", "tool_input", "status"]
    );
    assert_eq!(delta["block_id"], json!("call_00_dsds8smxoghqk8uo3at3gz39"));
    assert_eq!(delta["tool_input"], json!({"command": "ls"}));
    assert_eq!(delta["status"], json!("generating_arguments"));

    let done = updated_payload(
        event.task_id,
        event.subtask_id,
        event.tool_use_id.as_deref().unwrap_or_default(),
        &argument_updates(&event, "pending"),
    );
    assert_eq!(done["status"], json!("pending"));
}

#[test]
fn argument_frames_omit_a_missing_tool_input() {
    let mut event = tool_start_event();
    event.tool_input = None;

    let payload = updated_payload(
        event.task_id,
        event.subtask_id,
        event.tool_use_id.as_deref().unwrap_or_default(),
        &argument_updates(&event, "generating_arguments"),
    );

    assert_eq!(
        keys(&payload),
        vec!["task_id", "subtask_id", "block_id", "status"]
    );
}

#[test]
fn tool_result_frame_orders_output_before_input() {
    let mut event = tool_start_event();
    event.tool_input = Some(json!({"file_path": "/tmp/a.docx"}));
    event.tool_output = Some(json!("{\"success\": true}"));

    let payload = updated_payload(
        event.task_id,
        event.subtask_id,
        event.tool_use_id.as_deref().unwrap_or_default(),
        &result_updates(&event),
    );

    assert_eq!(
        keys(&payload),
        vec![
            "task_id",
            "subtask_id",
            "block_id",
            "tool_output",
            "tool_input",
            "status"
        ]
    );
    assert_eq!(payload["status"], json!("done"));
    assert!(
        python_dumps(&payload).contains(
            "\"tool_output\": \"{\\\"success\\\": true}\", \"tool_input\": {\"file_path\":"
        )
    );
}

#[test]
fn tool_result_frame_marks_failed_and_error_statuses() {
    for status in ["failed", "error"] {
        let mut event = tool_start_event();
        event.tool_input = None;
        event.tool_output = Some(Value::Null);
        event
            .data
            .insert("status".into(), Value::String(status.into()));

        let payload = updated_payload(
            event.task_id,
            event.subtask_id,
            event.tool_use_id.as_deref().unwrap_or_default(),
            &result_updates(&event),
        );

        assert_eq!(payload["status"], json!("error"));
        assert_eq!(
            keys(&payload),
            vec!["task_id", "subtask_id", "block_id", "status"]
        );
    }
}

#[test]
fn direct_block_created_forwards_the_block_verbatim() {
    let mut event = ExecutionEvent::new(EventType::BlockCreated, 7, 9);
    event.data.insert(
        "block".into(),
        json!({"id": "text-1", "type": "text", "content": "hi"}),
    );

    let payload = direct_created_payload(&event).expect("frame");

    assert_eq!(keys(&payload), vec!["task_id", "subtask_id", "block"]);
    assert_eq!(
        payload["block"],
        json!({"id": "text-1", "type": "text", "content": "hi"})
    );
}

#[test]
fn direct_block_created_requires_an_object_block() {
    let mut event = ExecutionEvent::new(EventType::BlockCreated, 7, 9);
    assert!(direct_created_payload(&event).is_none());

    event
        .data
        .insert("block".into(), Value::String("text".into()));
    assert!(direct_created_payload(&event).is_none());
}

#[test]
fn direct_block_updated_keeps_only_the_declared_update_keys() {
    let mut event = ExecutionEvent::new(EventType::BlockUpdated, 7, 9);
    event
        .data
        .insert("block_id".into(), Value::String("call_1".into()));
    event.data.insert(
        "updates".into(),
        json!({
            "content": "body",
            "tool_input": {"command": "ls"},
            "tool_output": "ok",
            "parent_tool_use_id": "call_parent",
            "output": "out",
            "summary": "sum",
            "children": [{"id": "child"}],
            "status": "done",
            "render_payload": {"type": "interactive_form_question"},
            "unknown": true,
        }),
    );

    let payload = direct_updated_payload(&event).expect("frame");

    assert_eq!(
        keys(&payload),
        vec![
            "task_id",
            "subtask_id",
            "block_id",
            "content",
            "tool_output",
            "tool_input",
            "parent_tool_use_id",
            "output",
            "summary",
            "children",
            "status"
        ]
    );
    assert!(
        !payload
            .as_object()
            .expect("object")
            .contains_key("render_payload")
    );
    assert!(!payload.as_object().expect("object").contains_key("unknown"));
}

#[test]
fn direct_block_updated_omits_null_updates() {
    let mut event = ExecutionEvent::new(EventType::BlockUpdated, 7, 9);
    event
        .data
        .insert("block_id".into(), Value::String("call_1".into()));
    event
        .data
        .insert("updates".into(), json!({"content": null, "status": "done"}));

    let payload = direct_updated_payload(&event).expect("frame");

    assert_eq!(
        keys(&payload),
        vec!["task_id", "subtask_id", "block_id", "status"]
    );
}

#[test]
fn direct_block_updated_stringifies_the_block_id() {
    let mut event = ExecutionEvent::new(EventType::BlockUpdated, 7, 9);
    event.data.insert("block_id".into(), json!(42));
    event
        .data
        .insert("updates".into(), json!({"status": "done"}));

    let payload = direct_updated_payload(&event).expect("frame");

    assert_eq!(payload["block_id"], json!("42"));
}

#[test]
fn direct_block_updated_rejects_a_falsy_block_id_or_non_object_updates() {
    for block_id in [Value::Null, json!(0), json!(""), json!(false)] {
        let mut event = ExecutionEvent::new(EventType::BlockUpdated, 7, 9);
        event.data.insert("block_id".into(), block_id);
        event
            .data
            .insert("updates".into(), json!({"status": "done"}));
        assert!(direct_updated_payload(&event).is_none());
    }

    let mut event = ExecutionEvent::new(EventType::BlockUpdated, 7, 9);
    event
        .data
        .insert("block_id".into(), Value::String("call_1".into()));
    assert!(direct_updated_payload(&event).is_none());
    event
        .data
        .insert("updates".into(), Value::String("done".into()));
    assert!(direct_updated_payload(&event).is_none());
}

#[test]
fn guidance_blocks_only_include_guidance_entries_in_result_order() {
    let result = json!({
        "blocks": [
            {"id": "text-1", "type": "text", "content": "hi"},
            {"id": "guidance-1", "type": "guidance", "content": "first"},
            {"id": "guidance-2", "type": "guidance", "content": "second"},
        ],
    });

    let payloads = guidance_created_payloads(7, 9, &result);

    assert_eq!(payloads.len(), 2);
    assert_eq!(payloads[0]["block"]["id"], json!("guidance-1"));
    assert_eq!(payloads[1]["block"]["id"], json!("guidance-2"));
    assert_eq!(keys(&payloads[0]), vec!["task_id", "subtask_id", "block"]);

    assert!(guidance_created_payloads(7, 9, &json!({"blocks": "none"})).is_empty());
    assert!(guidance_created_payloads(7, 9, &json!({})).is_empty());
}

#[test]
fn updated_payload_orders_the_known_keys_by_the_source_signature() {
    let mut updates = Map::new();
    updates.insert("status".into(), json!("done"));
    updates.insert("children".into(), json!([]));
    updates.insert("tool_input".into(), json!({}));

    let payload = updated_payload(1, 2, "call_1", &updates);

    assert_eq!(
        python_dumps(&payload),
        "{\"task_id\": 1, \"subtask_id\": 2, \"block_id\": \"call_1\", \"tool_input\": {}, \"children\": [], \"status\": \"done\"}"
    );
}
