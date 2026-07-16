// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use serde_json::json;
use tokio::sync::Mutex;
use wegent_executor::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

const TEST_PROCESS_TIMEOUT_SECONDS: u64 = 3600;

#[derive(Clone)]
struct SlowSink {
    delay: Duration,
}

impl EventSink for SlowSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, _event: EventEnvelope) -> Self::SendFuture {
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Ok(())
        })
    }
}

#[derive(Clone)]
struct RecordingSlowSink {
    delay: Duration,
    events: Arc<Mutex<Vec<EventEnvelope>>>,
}

impl EventSink for RecordingSlowSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let delay = self.delay;
        let events = Arc::clone(&self.events);
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            events.lock().await.push(event);
            Ok(())
        })
    }
}

#[tokio::test]
async fn stream_process_engine_parses_ndjson_stdout() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_completes_with_slow_stream_callbacks() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        engine.run_with_events(
            ExecutionRequest::default(),
            SlowSink {
                delay: Duration::from_millis(50),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        ),
    )
    .await
    .expect("stream callbacks should flush without hanging");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_compacts_queued_text_callbacks_before_success() {
    let long_text = "x".repeat(5_000);
    let assistant = json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": long_text}]
        }
    })
    .to_string();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(format!(
            r#"printf '%s\n' '{}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}}'"#,
            assistant
        )),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let started = std::time::Instant::now();
    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            SlowSink {
                delay: Duration::from_millis(50),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    assert!(
        started.elapsed() < Duration::from_millis(600),
        "outcome waited for queued streaming callbacks to drain"
    );
    assert_eq!(outcome, ExecutionOutcome::Completed { content: long_text });
}

#[tokio::test]
async fn stream_process_engine_sends_remaining_text_delta_before_success() {
    let long_text = "x".repeat(5_000);
    let assistant = json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": long_text}]
        }
    })
    .to_string();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(format!(
            r#"printf '%s\n' '{}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}}'"#,
            assistant
        )),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );
    let events = Arc::new(Mutex::new(Vec::new()));

    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            RecordingSlowSink {
                delay: Duration::from_millis(50),
                events: Arc::clone(&events),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    let events = events.lock().await;
    let streamed_text: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data.get("delta").and_then(|value| value.as_str()))
        .collect();
    assert_eq!(streamed_text, long_text);
    assert_eq!(outcome, ExecutionOutcome::Completed { content: long_text });
}

#[tokio::test]
async fn stream_process_engine_preserves_queued_non_text_events_before_success() {
    let long_text = "x".repeat(5_000);
    let assistant = json!({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"path": "a.txt"}},
                {"type": "text", "text": long_text}
            ]
        }
    })
    .to_string();
    let tool_result = json!({
        "type": "user",
        "message": {
            "content": [
                {"type": "tool_result", "tool_use_id": "tool-1", "content": "ok"}
            ]
        }
    })
    .to_string();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(format!(
            r#"printf '%s\n' '{}' '{}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}}'"#,
            assistant, tool_result
        )),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );
    let events = Arc::new(Mutex::new(Vec::new()));

    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            RecordingSlowSink {
                delay: Duration::from_millis(50),
                events: Arc::clone(&events),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    let events = events.lock().await;
    assert!(events.iter().any(|event| {
        event.event_type == "response.block.updated"
            && event.data["block_id"] == "tool-1"
            && event.data["updates"]["tool_output"] == "ok"
    }));
    assert_eq!(outcome, ExecutionOutcome::Completed { content: long_text });
}

#[tokio::test]
async fn stream_process_engine_ignores_child_agent_assistant_text() {
    let child = json!({
        "type": "assistant",
        "parent_tool_use_id": "Agent_0",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "child draft"}]
        }
    })
    .to_string();
    let root = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "root final"}]
        }
    })
    .to_string();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(format!(
            r#"printf '%s\n' '{}' '{}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}}'"#,
            child, root
        )),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );
    let events = Arc::new(Mutex::new(Vec::new()));

    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            RecordingSlowSink {
                delay: Duration::from_millis(1),
                events: Arc::clone(&events),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    let events = events.lock().await;
    let streamed_text: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data.get("delta").and_then(|value| value.as_str()))
        .collect();
    assert_eq!(streamed_text, "root final");
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "root final".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_ignores_root_text_while_async_agent_is_running() {
    let task_started = json!({
        "type": "system",
        "subtype": "task_started",
        "task_type": "local_agent",
        "tool_use_id": "Agent_0",
        "task_id": "agent-1"
    })
    .to_string();
    let draft = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "draft before agent finishes"}]
        }
    })
    .to_string();
    let task_notification = json!({
        "type": "system",
        "subtype": "task_notification",
        "status": "completed",
        "tool_use_id": "Agent_0",
        "task_id": "agent-1",
        "summary": "child result"
    })
    .to_string();
    let final_message = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "final after agent"}]
        }
    })
    .to_string();
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(format!(
            r#"printf '%s\n' '{}' '{}' '{}' '{}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","result":"draft before agent finishes"}}' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","origin":{{"kind":"task-notification"}},"result":"final after agent"}}'"#,
            task_started, draft, task_notification, final_message
        )),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );
    let events = Arc::new(Mutex::new(Vec::new()));

    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            RecordingSlowSink {
                delay: Duration::from_millis(1),
                events: Arc::clone(&events),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    let events = events.lock().await;
    let streamed_text: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data.get("delta").and_then(|value| value.as_str()))
        .collect();
    assert_eq!(streamed_text, "final after agent");
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "final after agent".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_fails_when_claude_stdout_ends_without_result() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}'; printf '%s' '{"type":"user","message":{"content":[{"type":"tool_result","content":"broken"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert!(matches!(outcome, ExecutionOutcome::Failed { .. }));
    if let ExecutionOutcome::Failed { message } = outcome {
        assert!(message.contains("Claude stdout ended before result message"));
    }
}

#[tokio::test]
async fn stream_process_engine_keeps_stderr_for_process_failures() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh")
            .arg("-c")
            .arg("printf process-failed >&2; exit 3"),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "process-failed".to_owned()
        }
    );
}
