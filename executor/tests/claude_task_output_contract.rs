// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc, time::Duration};

use serde_json::{json, Value};
use tokio::sync::Mutex;
use wegent_executor::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    stream::{compact_claude_stdout_line, extract_claude_tool_results, ClaudeStdoutJsonBuffer},
};

const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

fn task_output_event(transcript: &str) -> Value {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "task-output-1",
                "content": "<retrieval_status>timeout</retrieval_status>\n[Truncated. Full output: /tmp/tasks/agent-1.output]"
            }]
        },
        "toolUseResult": {
            "retrieval_status": "timeout",
            "task": {
                "task_id": "agent-1",
                "task_type": "local_agent",
                "status": "running",
                "description": "Research progress",
                "isRawTranscript": true,
                "output": transcript,
                "result": transcript
            }
        }
    })
}

fn oversized_task_output_event() -> Value {
    // Each transcript fits separately; two UTF-8 copies exceed the byte limit.
    task_output_event(&"子代理日志\n".repeat(50_000))
}

#[test]
fn oversized_duplicate_transcripts_preserve_every_other_field() {
    for metadata_key in ["toolUseResult", "tool_use_result"] {
        let mut event = oversized_task_output_event();
        let metadata = event
            .as_object_mut()
            .unwrap()
            .remove("toolUseResult")
            .unwrap();
        event[metadata_key] = metadata;
        let raw = event.to_string();
        assert!(raw.len() > MAX_MESSAGE_BYTES);
        let original_tools = extract_claude_tool_results(&event);
        let task = event[metadata_key]["task"].as_object_mut().unwrap();
        task.remove("output");
        task.remove("result");

        let normalized = compact_claude_stdout_line(&raw, 172).unwrap();

        assert!(matches!(normalized, Cow::Owned(_)));
        assert!(normalized.len() < MAX_MESSAGE_BYTES);
        let actual: Value = serde_json::from_str(&normalized).unwrap();
        assert_eq!(actual, event);
        assert_eq!(extract_claude_tool_results(&actual), original_tools);
    }
}

#[test]
fn small_task_output_keeps_the_borrowed_fast_path_and_metadata() {
    let event = task_output_event("short transcript");
    let raw = event.to_string();

    let normalized = compact_claude_stdout_line(&raw, 1).unwrap();
    let parsed = ClaudeStdoutJsonBuffer::default()
        .push_line(&raw, 1)
        .unwrap();

    assert!(matches!(normalized, Cow::Borrowed(_)));
    assert_eq!(parsed, Some(event));
}

#[test]
fn unrelated_or_nonduplicate_payloads_still_exceed_the_limit() {
    for (pointer, replacement) in [
        ("/type", json!("result")),
        ("/toolUseResult/task/task_type", json!("local_bash")),
        ("/toolUseResult/task/isRawTranscript", json!(false)),
        ("/toolUseResult/task/result", json!("different result")),
        ("/message/content/0/type", json!("text")),
        ("/message/content/0/content", json!("")),
        ("/message/content/0/tool_use_id", json!("")),
    ] {
        // One transcript alone must exceed the limit for the nonduplicate case.
        let mut event = task_output_event(&"x".repeat(MAX_MESSAGE_BYTES + 1));
        *event.pointer_mut(pointer).unwrap() = replacement;

        let error = compact_claude_stdout_line(&event.to_string(), 172).unwrap_err();

        assert_eq!(error.line_number, 172);
        assert!(error.message.contains("maximum buffer size"), "{pointer}");
    }
}

#[test]
fn oversized_canonical_tool_body_is_not_truncated_and_buffer_recovers() {
    let mut event = oversized_task_output_event();
    event["message"]["content"][0]["content"] = json!("x".repeat(MAX_MESSAGE_BYTES + 1));
    let mut buffer = ClaudeStdoutJsonBuffer::default();

    assert!(buffer.push_line(&event.to_string(), 172).is_err());
    let next = json!({"type": "result", "subtype": "success", "result": "final report"});
    assert_eq!(
        buffer.push_line(&next.to_string(), 173).unwrap(),
        Some(next)
    );
}

#[test]
fn fragmented_json_uses_the_same_transcript_normalization() {
    let event = oversized_task_output_event();
    let raw = event.to_string();
    let split = raw.find("子代理").unwrap() + "子代理".len();
    let mut buffer = ClaudeStdoutJsonBuffer::default();

    assert!(buffer.push_line(&raw[..split], 171).unwrap().is_none());
    let normalized = buffer.push_line(&raw[split..], 172).unwrap().unwrap();

    assert_eq!(normalized["message"], event["message"]);
    assert!(normalized["toolUseResult"]["task"].get("output").is_none());
    assert!(normalized["toolUseResult"]["task"].get("result").is_none());
}

#[test]
fn raw_message_limit_still_rejects_incomplete_json() {
    let mut buffer = ClaudeStdoutJsonBuffer::default();
    assert!(buffer.push_line("{\"payload\":\"", 1).unwrap().is_none());

    let error = buffer
        .push_line(&"x".repeat(64 * MAX_MESSAGE_BYTES), 2)
        .unwrap_err();

    assert_eq!(error.line_number, 2);
    assert!(error.message.contains("maximum raw size of 67108864 bytes"));
    assert_eq!(buffer.push_line("{}", 3).unwrap(), Some(json!({})));
}

#[test]
fn structured_tool_body_is_preserved_when_metadata_is_compacted() {
    let mut event = oversized_task_output_event();
    event["message"]["content"][0]["content"] = json!([
        {"type": "text", "text": "Full output: /tmp/tasks/agent-1.output"}
    ]);

    let normalized = ClaudeStdoutJsonBuffer::default()
        .push_line(&event.to_string(), 1)
        .unwrap()
        .unwrap();

    assert_eq!(normalized["message"], event["message"]);
    assert!(normalized["toolUseResult"]["task"].get("output").is_none());
    assert!(normalized["toolUseResult"]["task"].get("result").is_none());
}

#[derive(Clone, Default)]
struct RecordingSink(Arc<Mutex<Vec<EventEnvelope>>>);

impl EventSink for RecordingSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let events = Arc::clone(&self.0);
        Box::pin(async move {
            events.lock().await.push(event);
            Ok(())
        })
    }
}

#[tokio::test]
async fn process_continues_to_final_answer_after_oversized_task_output() {
    let output = format!(
        "{}\n{}\n{}\n",
        oversized_task_output_event(),
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "final report"}]}}),
        json!({"type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn"})
    );
    let sink = RecordingSink::default();
    let engine = StreamProcessEngine::new(CommandSpec::new("cat").stdin(output), 30);

    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        engine.run_with_events(
            ExecutionRequest::default(),
            sink.clone(),
            ResponsesEventBuilder::new("task", "subtask", "model"),
        ),
    )
    .await
    .expect("oversized task metadata must not block process completion");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "final report".to_owned()
        }
    );
    let events = sink.0.lock().await;
    let text: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data["delta"].as_str())
        .collect();
    assert_eq!(text, "final report");
}
