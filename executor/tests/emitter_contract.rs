// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use wegent_executor::emitter::{EventEnvelope, ResponsesEventBuilder};

#[test]
fn response_created_event_matches_callback_envelope_contract() {
    let builder = ResponsesEventBuilder::new(123, 456, "claude-sonnet-4")
        .with_response_id("resp_test")
        .with_executor_info(Some("executor-1"), Some("default"));

    let event = builder.response_created(Some("ClaudeCode"));

    assert_eq!(
        event,
        EventEnvelope {
            event_type: "response.created".to_owned(),
            task_id: 123,
            subtask_id: 456,
            message_id: None,
            executor_name: Some("executor-1".to_owned()),
            executor_namespace: Some("default".to_owned()),
            data: json!({
                "type": "response.created",
                "shell_type": "ClaudeCode",
                "response": {
                    "id": "resp_test",
                    "object": "response",
                    "created_at": event.data["response"]["created_at"],
                    "model": "claude-sonnet-4",
                    "status": "in_progress",
                    "output": []
                }
            })
        }
    );
}

#[test]
fn response_completed_event_contains_message_output() {
    let builder = ResponsesEventBuilder::new(1, 2, "gpt-5").with_response_id("resp_done");

    let event = builder.response_completed("finished");

    assert_eq!(event.event_type, "response.completed");
    assert_eq!(event.data["response"]["id"], json!("resp_done"));
    assert_eq!(event.data["response"]["status"], json!("completed"));
    assert_eq!(
        event.data["response"]["output"][0]["content"][0]["text"],
        json!("finished")
    );
    assert_eq!(event.data["response"]["output"][0]["id"], json!("msg_2"));
}

#[test]
fn response_waiting_for_user_input_event_marks_silent_exit() {
    let builder =
        ResponsesEventBuilder::new(1, 2, "claude-sonnet-4").with_response_id("resp_waiting");

    let event = builder.response_waiting_for_user_input("tool_deferred");

    assert_eq!(event.event_type, "response.completed");
    assert_eq!(event.data["response"]["id"], json!("resp_waiting"));
    assert_eq!(event.data["response"]["status"], json!("completed"));
    assert_eq!(event.data["response"]["output"], json!([]));
    assert_eq!(
        event.data["response"]["stop_reason"],
        json!("tool_deferred")
    );
    assert_eq!(event.data["response"]["silent_exit"], json!(true));
    assert_eq!(
        event.data["response"]["silent_exit_reason"],
        json!("waiting_for_user_input")
    );
}

#[test]
fn error_event_uses_openai_error_shape() {
    let builder = ResponsesEventBuilder::new(1, 2, "");

    let event = builder.error("failed", "runtime_error");

    assert_eq!(
        event.data,
        json!({
            "type": "error",
            "code": "runtime_error",
            "message": "failed"
        })
    );
}
