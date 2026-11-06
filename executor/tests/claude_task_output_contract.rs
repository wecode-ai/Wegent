// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{borrow::Cow, future::Future, pin::Pin, process::Command, sync::Arc, time::Duration};

use serde_json::{json, Value};
use tokio::sync::Mutex;
use wegent_executor::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    stream::{
        collect_claude_stream_summary, compact_claude_stdout_line, extract_claude_tool_results,
        ClaudeStdoutJsonBuffer,
    },
};

const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RAW_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const BUFFER_LIMIT_ENV: &str = "WEGENT_CLAUDE_STDOUT_MAX_BUFFER_BYTES";
const BUFFER_LIMIT_TEST_CASE: &str = "WEGENT_TEST_CLAUDE_STDOUT_LIMIT_CASE";

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
    // The two transcript copies together put the event just above the limit.
    task_output_event(&format!("子代理{}", "x".repeat(MAX_MESSAGE_BYTES / 2)))
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
fn task_outputs_within_limit_keep_the_borrowed_fast_path_and_metadata() {
    for (transcript, minimum_bytes) in [
        ("short transcript".to_owned(), 0),
        ("子代理日志\n".repeat(50_000), 1024 * 1024),
    ] {
        let event = task_output_event(&transcript);
        let raw = event.to_string();
        assert!(raw.len() < MAX_MESSAGE_BYTES);
        assert!(raw.len() > minimum_bytes);

        let normalized = compact_claude_stdout_line(&raw, 1).unwrap();
        let parsed = ClaudeStdoutJsonBuffer::default()
            .push_line(&raw, 1)
            .unwrap();

        assert!(matches!(normalized, Cow::Borrowed(_)));
        assert_eq!(parsed, Some(event));
    }
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
        .push_line(&"x".repeat(MAX_RAW_MESSAGE_BYTES), 2)
        .unwrap_err();

    assert_eq!(error.line_number, 2);
    assert!(error.message.contains("maximum raw size of 67108864 bytes"));
    assert_eq!(buffer.push_line("{}", 3).unwrap(), Some(json!({})));
}

#[test]
fn stdout_buffer_limit_uses_the_executor_process_environment() {
    for (case, limit) in [
        ("default", None),
        ("smaller", Some("1048576")),
        ("larger", Some(" 20971520 ")),
        ("invalid", Some("10MiB")),
        ("utf8_boundary", Some("11")),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "stdout_buffer_limit_subprocess",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(BUFFER_LIMIT_TEST_CASE, case)
            .env_remove(BUFFER_LIMIT_ENV)
            .env("WEGENT_EXECUTOR_HOME", home.path())
            .env("WEGENT_EXECUTOR_DISABLE_FILE_LOG", "1")
            .env("WEGENT_DEBUG_CLAUDE_STDOUT", "0");
        if let Some(limit) = limit {
            command.env(BUFFER_LIMIT_ENV, limit);
        }
        let output = command.output().unwrap();
        let diagnostics = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.status.success(), "{case}: {diagnostics}");
        assert!(
            diagnostics.contains("test result: ok. 1 passed;"),
            "{case}: subprocess test did not run: {diagnostics}"
        );
        if case == "invalid" {
            assert_eq!(
                diagnostics
                    .matches("invalid claude stdout buffer limit")
                    .count(),
                1
            );
        }
    }
}

fn configured_task_output(case: &str) -> Value {
    let transcript = if case == "larger" {
        "x".repeat(6 * 1024 * 1024)
    } else {
        "原始记录\n".repeat(50_000)
    };
    let mut event = task_output_event(&transcript);
    if case != "larger" {
        event["toolUseResult"]["task"]
            .as_object_mut()
            .unwrap()
            .remove("isRawTranscript");
    }
    event
}

fn assert_configured_utf8_boundary() {
    let line = json!({"x": "汉"}).to_string();
    assert_eq!(line.len(), 11);
    assert!(matches!(
        compact_claude_stdout_line(&line, 1).unwrap(),
        Cow::Borrowed(_)
    ));
    let mut buffer = ClaudeStdoutJsonBuffer::default();
    assert!(buffer.push_line("{\"x\":", 1).unwrap().is_none());
    assert_eq!(
        buffer.push_line("\"汉\"}", 2).unwrap(),
        Some(json!({"x": "汉"}))
    );
    let larger = json!({"x": "汉a"}).to_string();
    assert!(larger.chars().count() < 11);
    let error = compact_claude_stdout_line(&larger, 3).unwrap_err();
    assert!(error.message.contains("maximum buffer size of 11 bytes"));
}

#[tokio::test]
async fn stdout_buffer_limit_subprocess() {
    let Ok(case) = std::env::var(BUFFER_LIMIT_TEST_CASE) else {
        return;
    };
    if case == "utf8_boundary" {
        assert_configured_utf8_boundary();
        return;
    }
    let mut event = configured_task_output(&case);
    let raw = event.to_string();
    assert!(raw.len() > 1024 * 1024);
    assert_eq!(raw.len() > MAX_MESSAGE_BYTES, case == "larger");
    let expected = if case == "smaller" {
        let error = compact_claude_stdout_line(&raw, 1).unwrap_err();
        assert!(error
            .message
            .contains("maximum buffer size of 1048576 bytes"));
        event["toolUseResult"]["task"]["isRawTranscript"] = json!(true);
        let marked_raw = event.to_string();
        let normalized = compact_claude_stdout_line(&marked_raw, 1).unwrap();
        assert!(matches!(normalized, Cow::Owned(_)));
        let normalized: Value = serde_json::from_str(&normalized).unwrap();
        let task = event["toolUseResult"]["task"].as_object_mut().unwrap();
        task.remove("output");
        task.remove("result");
        assert_eq!(normalized, event);
        ExecutionOutcome::Failed {
            message: error.failure_message(),
        }
    } else {
        let normalized = compact_claude_stdout_line(&raw, 1).unwrap();
        assert!(matches!(normalized, Cow::Borrowed(_)));
        assert_eq!(serde_json::from_str::<Value>(&normalized).unwrap(), event);
        assert_eq!(
            ClaudeStdoutJsonBuffer::default()
                .push_line(&raw, 1)
                .unwrap(),
            Some(event)
        );
        ExecutionOutcome::Completed {
            content: "final report".to_owned(),
        }
    };
    // The limit stays consistent across normalization, streaming, and final collection.
    // This mutation is isolated in a single-test subprocess, never the parent suite.
    std::env::set_var(BUFFER_LIMIT_ENV, "2");
    assert_configured_process_outcome(raw, expected).await;
}

async fn assert_configured_process_outcome(raw: String, expected: ExecutionOutcome) {
    let output = format!(
        "{}\n{}\n{}\n",
        raw,
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "final report"}]}}),
        json!({"type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn"})
    );
    assert_eq!(collect_claude_stream_summary(&output).outcome, expected);
    let sink = RecordingSink::default();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("cat").stdin(output),
        30,
        std::sync::Arc::new(wegent_executor::process_environment::CredentialEnvironment),
    );
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        engine.run_with_events(
            ExecutionRequest::default(),
            sink.clone(),
            ResponsesEventBuilder::new("task", "subtask", "model"),
        ),
    )
    .await
    .expect("configured stdout limit must settle the process");
    assert_eq!(outcome, expected);
    let events = sink.0.lock().await;
    let text: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data["delta"].as_str())
        .collect();
    assert_eq!(
        text,
        if matches!(expected, ExecutionOutcome::Completed { .. }) {
            "final report"
        } else {
            ""
        }
    );
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
    let engine = StreamProcessEngine::new(
        CommandSpec::new("cat").stdin(output),
        30,
        std::sync::Arc::new(wegent_executor::process_environment::CredentialEnvironment),
    );

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
